"""Pydantic models mirroring the frontend's src/types.ts.

Field names are camelCase on purpose so the JSON the React app already produces
and consumes maps 1:1 with no alias gymnastics.
"""
from __future__ import annotations

from typing import List, Literal, Optional, Tuple

from pydantic import BaseModel, Field


class ENUVector(BaseModel):
    x: float  # East (m)
    y: float  # North (m)
    z: float  # Up (m)


class BuildingFootprint(BaseModel):
    id: str
    name: Optional[str] = None
    enuPoints: List[ENUVector]
    height: float
    category: Literal["building", "infrastructure", "terrain", "water"]
    material: str = "itu_concrete"
    type: str = ""
    levels: Optional[float] = None
    # `points` (lat/lon) is sent by the frontend but unused by the solver.
    points: Optional[list] = None


class Transmitter(BaseModel):
    id: str = "tx"
    name: str = "Tx"
    enu: ENUVector
    height: float = 10.0
    powerDbm: float = 30.0
    antennaArraySize: Tuple[int, int] = (8, 8)  # [horizontal, vertical]
    beamsteeringAzimuth: float = 0.0
    beamsteeringElevation: float = 0.0
    latitude: Optional[float] = None
    longitude: Optional[float] = None


class Receiver(BaseModel):
    id: str = "rx"
    name: str = "Rx"
    enu: ENUVector
    height: float = 1.5
    antennaArraySize: Tuple[int, int] = (1, 1)
    latitude: Optional[float] = None
    longitude: Optional[float] = None


class PropagationPath(BaseModel):
    id: str
    points: List[ENUVector]
    type: Literal["LOS", "Reflection", "Diffraction", "NLOS"]
    order: int
    distance: float
    pathLossDb: float
    receivedPowerDbm: float
    delayNs: float
    phasesRad: List[float] = Field(default_factory=list)
    materialsReached: List[str] = Field(default_factory=list)
    # Exact per-bounce interaction types (specular/diffuse/refraction/diffraction),
    # straight from paths.interactions — more precise than the coarse `type`.
    interactionKinds: List[str] = Field(default_factory=list)
    # Angles of departure (Tx) and arrival (Rx), degrees. Azimuth is measured
    # clockwise from North (0=N, 90=E); elevation is above the horizon.
    aodAzimuthDeg: Optional[float] = None
    aodElevationDeg: Optional[float] = None
    aoaAzimuthDeg: Optional[float] = None
    aoaElevationDeg: Optional[float] = None
    # Which transmitter this ray departs from (set when several Tx are solved at
    # once, e.g. multi-Tx mobility). None for single-Tx solves.
    txId: Optional[str] = None


class ChannelMetrics(BaseModel):
    totalRxPowerDbm: float
    losStatus: Literal["LOS", "NLOS"]
    numPaths: int
    rmsDelaySpreadNs: float
    # False only when a scalar delay spread is not physically defined (currently
    # non-coherent multi-transmitter power aggregation in mobility mode).
    rmsDelaySpreadValid: bool = True
    strongestPathPowerDbm: float
    strongestPathType: str


class RadioMapCell(BaseModel):
    x: float
    y: float
    z: float
    powerDbm: float       # best-server received power (RSS) [dBm]
    # Geometric LOS approximation from the 2D footprints, NOT a Sionna RadioMap
    # output (which exposes path gain / RSS / SINR only). Used only as a UI and
    # synthetic channel-grid hint.
    isLos: bool
    sinr: Optional[float] = None      # best-server signal-to-interference-plus-noise [dB]
    servingTx: Optional[int] = None   # index of the serving transmitter


class CoverageStats(BaseModel):
    """Coverage statistics over the radio map for the selected metric."""
    metric: str            # "power" | "sinr"
    unit: str              # "dBm" | "dB"
    thresholdDb: float     # served threshold used
    servedPercent: float   # % of reachable cells at/above the threshold
    p5: float
    p50: float
    p95: float
    minVal: float
    maxVal: float


class RadioMapGrid(BaseModel):
    cells: List[RadioMapCell]
    minX: float
    maxX: float
    minY: float
    maxY: float
    gridSize: float
    heightOffset: float
    metric: str = "power"             # which field `powerDbm` carries
    unit: str = "dBm"
    stats: Optional[CoverageStats] = None
    samplesPerTx: int = 1_000_000
    seed: int = 42


# ── Request / response envelopes ────────────────────────────────────────────

class SolverOptions(BaseModel):
    """Per-interaction-type ray tracing switches + Tx/Rx antenna config.

    Mirrors the feature checkboxes / antenna array panel of NVIDIA's
    sionna-rt-gui. Interaction switches and Tx configuration apply to both
    solvers; Rx configuration applies to PathSolver because RadioMapSolver uses
    its documented ideal map-receiver model.
    """
    los: bool = True
    specularReflection: bool = True
    diffuseReflection: bool = False
    refraction: bool = False
    diffraction: bool = False
    edgeDiffraction: bool = False
    txPattern: Literal["iso", "dipole", "hw_dipole", "tr38901"] = "tr38901"
    txPolarization: Literal["V", "H", "VH", "cross"] = "V"
    rxPattern: Literal["iso", "dipole", "hw_dipole", "tr38901"] = "iso"
    rxPolarization: Literal["V", "H", "VH", "cross"] = "V"
    # PathSolver shooting-and-bouncing controls. These are distinct from the
    # RadioMapSolver's samplesPerTx/seed because the algorithms differ.
    pathSamplesPerSource: int = Field(default=1_000_000, ge=10_000, le=10_000_000)
    pathSeed: int = Field(default=42, ge=0, le=2_147_483_647)


class MaterialConfig(BaseModel):
    """Per-material electromagnetic + scattering overrides applied to the scene.

    `id` matches the frontend material id (e.g. ``itu_concrete``). Scattering
    fields map to Sionna's RadioMaterial. When permittivity/conductivity are set,
    a custom RadioMaterial replaces the ITU preset for that id.
    """
    id: str
    scatteringCoefficient: float = 0.0  # S in [0, 1]
    xpdCoefficient: float = 0.0         # cross-pol discrimination in [0, 1]
    scatteringPattern: Literal["none", "lambertian", "directive", "backscattering"] = "none"
    relativePermittivity: Optional[float] = None
    conductivity: Optional[float] = None  # S/m
    thickness: Optional[float] = None     # m


class SolveRequest(BaseModel):
    tx: Transmitter
    rx: Receiver
    buildings: List[BuildingFootprint]
    freqGhz: float = 28.0
    maxDepth: int = 3  # max ray-tracing interaction depth (reflections/diffractions)
    options: SolverOptions = Field(default_factory=SolverOptions)
    materials: List[MaterialConfig] = Field(default_factory=list)


class SolveResponse(BaseModel):
    paths: List[PropagationPath]
    metrics: ChannelMetrics


class RadioMapRequest(BaseModel):
    tx: Optional[Transmitter] = None          # single transmitter (legacy)
    txs: Optional[List[Transmitter]] = None   # multiple transmitters (best-server)
    buildings: List[BuildingFootprint]
    freqGhz: float = 28.0
    gridSize: float = 5.0
    gridHeight: float = 1.5
    maxDepth: int = 3
    options: SolverOptions = Field(default_factory=SolverOptions)
    materials: List[MaterialConfig] = Field(default_factory=list)
    # Which Sionna metric to map: best-server received power, or interference-aware SINR.
    metric: Literal["power", "sinr"] = "power"
    bandwidthHz: float = 100e6   # sets scene.bandwidth → thermal noise for SINR
    noiseFigureDb: float = 7.0   # receiver noise figure added to thermal noise
    coverageThresholdDb: Optional[float] = None  # served threshold (per-metric default)
    # Research/reproducibility controls passed directly to RadioMapSolver.
    samplesPerTx: int = Field(default=1_000_000, ge=1_000, le=10_000_000)
    seed: int = Field(default=42, ge=0, le=2_147_483_647)

    def transmitters(self) -> List[Transmitter]:
        """All transmitters to map, accepting either `txs` or legacy `tx`."""
        if self.txs:
            return self.txs
        if self.tx is not None:
            return [self.tx]
        raise ValueError("RadioMapRequest needs `txs` or `tx`")


# ── Mobility (Rx trajectory) ────────────────────────────────────────────────

class TxLinkMetrics(BaseModel):
    """One transmitter's link to the receiver at a single mobility waypoint.

    Lets the UI show every Tx the moving Rx sees (and association changes),
    not just the serving one. ``receivedPowerDbm`` is this Tx's total over its
    own multipath; the strongest of these per waypoint is the serving Tx.
    """
    txId: str
    txName: str
    receivedPowerDbm: float
    rmsDelaySpreadNs: float
    numPaths: int
    maxDopplerHz: float
    losStatus: Literal["LOS", "NLOS"]


class MobilityStep(BaseModel):
    index: int
    rxPosition: ENUVector
    # Scalar KPIs describe the SERVING (best-server) transmitter at this waypoint,
    # so the existing per-step metrics stay meaningful with one or many Tx.
    receivedPowerDbm: float
    rmsDelaySpreadNs: float
    rmsDelaySpreadValid: bool = True
    numPaths: int
    maxDopplerHz: float
    losStatus: Literal["LOS", "NLOS"]
    # Rays from EVERY transmitter to this waypoint (each tagged with its txId),
    # sorted strongest-first — so the 3D scene shows all Tx, not only the server.
    paths: List[PropagationPath]
    # Best-server transmitter and the per-Tx breakdown behind the scalar KPIs.
    servingTxId: Optional[str] = None
    servingTxName: Optional[str] = None
    perTx: List[TxLinkMetrics] = Field(default_factory=list)


class HandoverConfig(BaseModel):
    """A3-event association parameters applied to the mobility RSS series.

    ``hysteresisDb`` and ``timeToTriggerMs`` mirror the 3GPP A3 event: a
    neighbor must exceed the serving cell by the hysteresis continuously for
    the time-to-trigger before a handover fires. TTT is honored in seconds via
    the waypoint spacing and receiver speed.
    """
    hysteresisDb: float = Field(default=3.0, ge=0.0, le=15.0)
    timeToTriggerMs: float = Field(default=160.0, ge=0.0, le=5120.0)
    # A handover back to the cell just left within this window is a ping-pong.
    pingPongWindowS: float = Field(default=1.0, ge=0.0, le=10.0)


class HandoverEvent(BaseModel):
    stepIndex: int
    timeS: float          # trajectory time of the handover
    fromTxId: str
    fromTxName: str
    toTxId: str
    toTxName: str
    pingPong: bool = False


class HandoverAnalysis(BaseModel):
    """A3 (hysteresis + TTT) association over the mobility per-Tx RSS series.

    ``instantaneousChangeCount`` is the hysteresis-free baseline — how often the
    per-step ``servingTxId`` (instantaneous argmax) flips — so the suppression
    of ping-pong by the A3 parameters is directly visible.
    """
    hysteresisDb: float
    timeToTriggerMs: float
    pingPongWindowS: float
    servingTxIds: List[Optional[str]]  # A3 serving cell per step (None = unreachable)
    events: List[HandoverEvent] = Field(default_factory=list)
    handoverCount: int
    pingPongCount: int
    instantaneousChangeCount: int


class MobilityRequest(BaseModel):
    # `txs` ray-traces every transmitter to each waypoint (best-server mobility);
    # `tx` is the legacy single-transmitter form. At least one is required.
    tx: Optional[Transmitter] = None
    txs: Optional[List[Transmitter]] = None
    rx: Receiver
    buildings: List[BuildingFootprint]
    waypoints: List[ENUVector]
    freqGhz: float = 28.0
    speedKmh: float = 30.0
    maxDepth: int = 3
    options: SolverOptions = Field(default_factory=SolverOptions)
    materials: List[MaterialConfig] = Field(default_factory=list)
    # How to collapse multiple transmitters into each waypoint's scalar KPIs:
    #   "best_server" — report the single strongest Tx (instantaneous association)
    #   "sum"         — report non-coherent incident power over ALL Tx
    # Either way the scene still renders the union of every transmitter's rays.
    combineMode: Literal["best_server", "sum"] = "best_server"
    # Research/validation control. The UI uses "auto"; experiments can require
    # the batched result or run an identical-payload serial reference.
    executionMode: Literal["auto", "batched", "serial_reference"] = "auto"
    # A3 handover parameters; the analysis runs whenever ≥ 2 Tx are solved.
    handover: HandoverConfig = Field(default_factory=HandoverConfig)

    def transmitters(self) -> List[Transmitter]:
        """All transmitters to ray-trace, accepting either `txs` or legacy `tx`."""
        if self.txs:
            return self.txs
        if self.tx is not None:
            return [self.tx]
        raise ValueError("MobilityRequest needs `txs` or `tx`")


class MobilityExecution(BaseModel):
    """Auditable execution metadata for one mobility API call.

    ``strategy`` makes a defensive serial fallback visible instead of silently
    presenting it as the one-dispatch fast path used in performance claims.
    ``solveTimeMs`` is measured while holding the solver lock, so it excludes
    HTTP transfer and time waiting for another request to finish.
    """
    strategy: Literal[
        "single_batched_dispatch", "serial_pair_fallback", "serial_reference"
    ]
    batchedResultUsed: bool
    transmitterCount: int
    waypointCount: int
    pairCount: int
    successfulPathSolverDispatches: int
    samplesPerSource: int
    seed: int
    solveTimeMs: float = 0.0


class MobilityResponse(BaseModel):
    steps: List[MobilityStep]
    execution: MobilityExecution
    # A3 hysteresis/TTT association — present when ≥ 2 transmitters were solved.
    handover: Optional[HandoverAnalysis] = None


# ── Channel impulse / frequency response export ─────────────────────────────

class CIRRequest(BaseModel):
    """Export the raw channel impulse response (CIR) and channel frequency
    response (CFR) for one or more devices — the same arrays you get in Python
    via ``a, tau = paths.cir(...)`` and ``h = paths.cfr(frequencies=...)``.

    ``tx``/``rx`` are the legacy single-link form. ``txs``/``rxs`` place all
    devices into one Sionna scene so the returned tensors retain their native
    receiver and transmitter axes.
    """
    tx: Optional[Transmitter] = None
    rx: Optional[Receiver] = None
    txs: Optional[List[Transmitter]] = None
    rxs: Optional[List[Receiver]] = None
    buildings: List[BuildingFootprint]
    freqGhz: float = 28.0
    maxDepth: int = 3
    options: SolverOptions = Field(default_factory=SolverOptions)
    materials: List[MaterialConfig] = Field(default_factory=list)
    # OFDM grid the CFR is sampled on (mirrors sionna.rt.subcarrier_frequencies).
    numSubcarriers: int = 1024
    subcarrierSpacing: float = 30_000.0  # Hz (5G NR numerology µ=1 → 30 kHz)
    normalizeDelays: bool = True
    format: Literal["npz", "cir_npz", "cir_csv", "cfr_csv"] = "npz"

    def transmitters(self) -> List[Transmitter]:
        """All transmitters, accepting either the scene-tensor or legacy form."""
        if self.txs:
            return self.txs
        if self.tx is not None:
            return [self.tx]
        raise ValueError("CIRRequest needs `txs` or `tx`")

    def receivers(self) -> List[Receiver]:
        """All receivers, accepting either the scene-tensor or legacy form."""
        if self.rxs:
            return self.rxs
        if self.rx is not None:
            return [self.rx]
        raise ValueError("CIRRequest needs `rxs` or `rx`")

    def validate_format_scope(self) -> None:
        """Reject lossy/ambiguous CSV flattening of multi-device tensors."""
        if self.format in ("cir_csv", "cfr_csv") and (
            len(self.transmitters()) > 1 or len(self.receivers()) > 1
        ):
            raise ValueError(
                "CSV export supports one Tx→Rx link; "
                "use .npz for the multi-device tensor"
            )


# ── Standalone Mitsuba/Sionna scene export ──────────────────────────────────

class SceneExportRequest(BaseModel):
    """Export the ray-tracing scene as a standalone Sionna RT project.

    Produces the Mitsuba scene the backend traces (``scene.xml`` + ``meshes/``)
    plus a generated ``load_scene.py`` that replays everything Sionna keeps in
    Python rather than in the XML: carrier frequency, radio-material overrides,
    exact Tx/Rx ``PlanarArray`` configurations, the devices themselves, and the
    ``PathSolver`` switches. Mixed arrays are replayed as compatible groups.
    Running that script in a notebook reproduces the app's solves without the app.

    Devices are optional — with none, the export is geometry only.
    """
    tx: Optional[Transmitter] = None
    rx: Optional[Receiver] = None
    txs: Optional[List[Transmitter]] = None
    rxs: Optional[List[Receiver]] = None
    buildings: List[BuildingFootprint]
    freqGhz: float = 28.0
    maxDepth: int = 3
    options: SolverOptions = Field(default_factory=SolverOptions)
    materials: List[MaterialConfig] = Field(default_factory=list)
    # OFDM grid the generated script samples the CFR on.
    numSubcarriers: int = 1024
    subcarrierSpacing: float = 30_000.0  # Hz
    normalizeDelays: bool = True

    def transmitters(self) -> List[Transmitter]:
        """All transmitters; empty is allowed (geometry-only export)."""
        if self.txs:
            return list(self.txs)
        return [self.tx] if self.tx is not None else []

    def receivers(self) -> List[Receiver]:
        """All receivers; empty is allowed (geometry-only export)."""
        if self.rxs:
            return list(self.rxs)
        return [self.rx] if self.rx is not None else []


# ── Link-level channel KPIs (Tier 1 — no PHY package) ──────────────────────

class LinkKpiRequest(BaseModel):
    """Compute Shannon-capacity KPIs for one Tx→Rx link from its ray-traced CFR.

    Same solve as the CIR/CFR export, but instead of returning raw arrays the
    backend reduces them to capacity / spectral-efficiency / spatial-structure
    KPIs (backend/linklevel.py). Noise is thermal over the OFDM band
    (numSubcarriers × subcarrierSpacing) plus the receiver noise figure —
    the same convention as the radio map's SINR floor.
    """
    tx: Transmitter
    rx: Receiver
    buildings: List[BuildingFootprint]
    freqGhz: float = 28.0
    maxDepth: int = 3
    options: SolverOptions = Field(default_factory=SolverOptions)
    materials: List[MaterialConfig] = Field(default_factory=list)
    numSubcarriers: int = 1024
    subcarrierSpacing: float = 30_000.0  # Hz
    normalizeDelays: bool = True
    noiseFigureDb: float = 7.0
    # Evaluate the capacity KPIs at this receive SNR instead of the link budget's
    # (uniform-precoding reference). The capacity-vs-SNR curve is returned anyway.
    snrOverrideDb: Optional[float] = None


class LinkKpiCurve(BaseModel):
    """Mean capacity [bit/s/Hz] vs receive SNR [dB] (uniform-precoding reference)."""
    snrDb: List[float]
    openLoop: List[float]
    beamformed: List[float]


class LinkKpiSpectrum(BaseModel):
    """Per-subcarrier series (decimated for display): beamformed channel gain
    [dB] and open-loop capacity [bit/s/Hz] at the operating SNR."""
    frequencyHz: List[float]  # baseband subcarrier offsets
    gainDb: List[float]
    capacity: List[float]


class LinkKpiResponse(BaseModel):
    reachable: bool          # False when no ray-traced path reaches the Rx
    numTxAnt: int
    numRxAnt: int
    numSubcarriers: int
    bandwidthHz: float
    noisePowerDbm: float
    snrSource: Literal["link_budget", "override"]
    rxPowerDbm: Optional[float]
    effectiveSnrDb: Optional[float]
    # Mean over subcarriers at the operating SNR [bit/s/Hz].
    capacityOpenLoopBitsHz: float    # log2 det(I + rho/Nt · H Hᴴ), no CSIT
    capacityBeamformedBitsHz: float  # single-stream MRT/MRC upper reference
    capacityUniformBitsHz: float     # the app's sum/sqrt(Nt) steered precoder
    throughputMbps: float            # open-loop capacity × bandwidth
    beamformingGainDb: Optional[float]  # MRT vs the steered uniform beam
    # Spatial structure of the frequency-averaged transmit covariance.
    conditionNumberDb: Optional[float]
    effectiveRank: Optional[float]
    spatialEigenvaluesDb: List[float] = Field(default_factory=list)
    coherenceBw50Hz: Optional[float] = None  # None = flat over the measured band
    curve: LinkKpiCurve
    spectrum: LinkKpiSpectrum


# ── Full PHY chain: NR PUSCH BER/BLER sweep (Tier 2, optional package) ──────

class PhyBerRequest(BaseModel):
    """BER/BLER-vs-Eb/N0 sweep of the active link through Sionna PHY's 5G NR
    PUSCH chain (LDPC + QAM + DMRS + LMMSE), replaying the ray-traced CIR.

    Runs as a background job: the RT solve holds the solver lock briefly, the
    CPU-side PHY sweep does not. Requires the optional ``sionna`` PHY package
    (see /api/health ``phy``). The CFR is normalized to unit average energy, so
    ``ebNoDb`` is relative to mean received symbol energy.
    """
    tx: Transmitter
    rx: Receiver
    buildings: List[BuildingFootprint]
    freqGhz: float = 28.0
    maxDepth: int = 3
    options: SolverOptions = Field(default_factory=SolverOptions)
    materials: List[MaterialConfig] = Field(default_factory=list)
    # PUSCH configuration (3GPP 38.214 MCS table 1) + sweep grid.
    mcsIndex: int = Field(default=14, ge=0, le=27)
    numPrb: int = Field(default=24, ge=4, le=273)
    subcarrierSpacing: float = 30_000.0  # Hz (15/30/60/120 kHz)
    # solve_cir plumbing: the sweep re-samples the CIR on the PUSCH grid, so the
    # incidental CFR stays tiny; delay normalization aligns taps with the CP.
    numSubcarriers: int = 64
    normalizeDelays: bool = True
    snrMinDb: float = -10.0
    snrMaxDb: float = 14.0
    snrStepDb: float = Field(default=2.0, gt=0.0)
    slotsPerPoint: int = Field(default=32, ge=4, le=512)
    seed: int = Field(default=42, ge=0, le=2_147_483_647)


class PhyBerPoint(BaseModel):
    ebNoDb: float
    ber: float
    bler: float
    bitErrors: int
    bits: int
    blockErrors: int
    blocks: int


class PhyBerResult(BaseModel):
    points: List[PhyBerPoint]
    mcsIndex: int
    modulationOrder: int      # bits per QAM symbol
    targetCoderate: float
    numPrb: int
    numSubcarriers: int
    subcarrierSpacingHz: float
    numRxAnt: int             # base-station elements (uplink receive side)
    numTxAnt: int             # effective PUSCH streams (currently one)
    numUeArrayPorts: int      # physical UE ports under the uniform precoder
    numPaths: int
    slotsPerPoint: int
    transportBlockBits: int
    seed: int


class PhyBerJobStatus(BaseModel):
    jobId: str
    status: Literal["running", "done", "error"]
    progress: float           # 0..1
    message: str = ""
    result: Optional[PhyBerResult] = None


# ── Per-cell ray-traced channel grid ────────────────────────────────────────

class ChannelGridRequest(BaseModel):
    """Build a per-cell channel grid by ray-tracing every radio-map cell.

    Unlike the frontend's coverage-derived proxy, this keeps the real
    ``paths.cfr()`` Tx- and Rx-antenna axes plus ray-traced LOS and received
    power. Cells are solved in ``chunkSize``-receiver PathSolver batches.
    """
    tx: Transmitter
    # The position is ignored because `cells` supplies every target position.
    # Array size plus SolverOptions' Rx pattern/polarization configure the one
    # scene.rx_array shared by all cell receivers, exactly as in Sionna RT.
    rx: Optional[Receiver] = None
    buildings: List[BuildingFootprint]
    # Receiver positions = radio-map cell centers (ENU), sent verbatim so the
    # dataset coordinates match the displayed coverage grid exactly.
    cells: List[ENUVector]
    freqGhz: float = 28.0
    maxDepth: int = 3
    options: SolverOptions = Field(default_factory=SolverOptions)
    materials: List[MaterialConfig] = Field(default_factory=list)
    # OFDM grid the CFR is sampled on (mirrors sionna.rt.subcarrier_frequencies).
    numSubcarriers: int = 64
    subcarrierSpacing: float = 30_000.0  # Hz
    normalizeDelays: bool = True
    chunkSize: int = 512                 # receivers per GPU dispatch (bounds memory)
