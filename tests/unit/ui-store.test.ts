import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { CircleTakeAPI } from '@shared/api'
import type { GateReport, Project, Shot, Take } from '@shared/types'
import { IDLE_ENGINE, useStore } from '@renderer/store'

/**
 * The store is a mirror of MAIN's project: these tests drive it through a fake
 * `window.circletake` and assert the UI-side bookkeeping (selection validity,
 * compare toggling, gate progress, report cache invalidation).
 */

// ---------------------------------------------------------------------------
// Fixtures + fake bridge
// ---------------------------------------------------------------------------

function shot(id: string, name: string, order: number): Shot {
  return { id, name, order, characterIds: [] }
}

function take(id: string, shotId: string, overall = 90, circled = false): Take {
  return {
    id,
    shotId,
    mediaPath: `/media/${id}.mp4`,
    fileName: `${id}.mp4`,
    ingestedAt: '2026-07-21T00:00:00.000Z',
    provenance: {},
    probe: { durationSec: 5, fps: 24, width: 1920, height: 1080, codec: 'h264' },
    gate: {
      status: 'pass',
      overall,
      checks: {},
      engineVersion: '1.0.0',
      ranAt: '2026-07-22T00:00:00.000Z',
    },
    circled,
    rating: 0,
  }
}

function baseProject(): Project {
  return {
    schema: 1,
    name: 'FIXTURE',
    createdAt: '2026-07-20T00:00:00.000Z',
    settings: { copyMediaIntoProject: false },
    shots: [shot('s2', '14', 1), shot('s1', '12', 0)],
    takes: [take('t1', 's1', 91), take('t2', 's1', 74), take('t3', 's2', 88)],
    characters: [],
  }
}

interface Fake {
  api: CircleTakeAPI
  project: Project
  emitProject(next: Project): void
  emitGateProgress(e: { takeId: string; stage: string; pct: number }): void
  calls: string[]
  reports: Map<string, GateReport>
}

function makeFake(initial: Project = baseProject()): Fake {
  let project = initial
  const calls: string[] = []
  const reports = new Map<string, GateReport>()
  let projectCb: ((p: Project) => void) | null = null
  let gateCb: ((e: { takeId: string; stage: string; pct: number }) => void) | null = null

  const record = <T>(name: string, value: T): T => {
    calls.push(name)
    return value
  }

  const api = {
    createProject: async () => record('createProject', project),
    openProject: async () => record('openProject', project),
    getProject: async () => project,
    getProjectPath: async () => '/films/Fixture.ctake',
    getRecentProjects: async () => [
      { path: '/films/Fixture.ctake', name: 'FIXTURE', openedAt: '2026-07-24T00:00:00.000Z' },
    ],
    chooseMediaFiles: async () => record('chooseMediaFiles', ['/inbox/a.mp4']),
    chooseImageFiles: async () => record('chooseImageFiles', ['/refs/a.png']),
    chooseFolder: async () => record('chooseFolder', '/films'),
    chooseProjectFile: async () => record('chooseProjectFile', '/films/Fixture.ctake'),
    chooseSavePath: async (n: string) => record('chooseSavePath', `/out/${n}`),
    addShot: async () => record('addShot', project),
    updateShot: async () => record('updateShot', project),
    deleteShot: async () => record('deleteShot', project),
    reorderShots: async () => record('reorderShots', project),
    ingestFiles: async () => record('ingestFiles', { added: 2, skipped: ['bad.txt — not media'] }),
    assignTake: async () => record('assignTake', project),
    setProvenance: async () => record('setProvenance', project),
    circleTake: async (takeId: string, circled: boolean) => {
      calls.push('circleTake')
      project = { ...project, takes: project.takes.map((t) => (t.id === takeId ? { ...t, circled } : t)) }
      return project
    },
    setRating: async () => record('setRating', project),
    setTakeWindow: async (takeId: string, inSec: number | null, outSec: number | null) => {
      calls.push(`setTakeWindow:${takeId}:${inSec}:${outSec}`)
      return project
    },
    setModelRates: async (rates: Record<string, number>) => {
      calls.push('setModelRates')
      project = { ...project, settings: { ...project.settings, modelRates: rates } }
      return project
    },
    deleteTake: async () => record('deleteTake', project),
    runGate: async (takeId: string) => {
      calls.push(`runGate:${takeId}`)
    },
    runGateAll: async () => {
      calls.push('runGateAll')
    },
    cancelGates: async () => {
      calls.push('cancelGates')
    },
    getGateReport: async (takeId: string) => {
      calls.push(`getGateReport:${takeId}`)
      return reports.get(takeId) ?? null
    },
    getEngineStatus: async () => ({ ready: true, stage: 'ready' as const, engineVersion: '1.0.0' }),
    addCharacter: async () => record('addCharacter', project),
    renameCharacter: async () => record('renameCharacter', project),
    deleteCharacter: async () => record('deleteCharacter', project),
    addKitImages: async () => record('addKitImages', project),
    removeKitImage: async () => record('removeKitImage', project),
    buildKit: async (id: string) => record('buildKit', { id, name: 'Maya', images: ['a.jpg'], locked: true }),
    setWatchFolder: async () => record('setWatchFolder', project),
    exportFcpxml: async (p: string) => record('exportFcpxml', p),
    exportEdl: async (p: string) => record('exportEdl', p),
    exportReshootList: async (p: string) => record('exportReshootList', p),
    exportCsv: async (p: string) => record('exportCsv', p),
    onProjectUpdated: (cb: (p: Project) => void) => {
      projectCb = cb
      return () => {
        projectCb = null
      }
    },
    onGateProgress: (cb: (e: { takeId: string; stage: string; pct: number }) => void) => {
      gateCb = cb
      return () => {
        gateCb = null
      }
    },
    onIngestProgress: () => () => undefined,
    onEngineStatus: () => () => undefined,
  } as unknown as CircleTakeAPI

  return {
    api,
    get project() {
      return project
    },
    emitProject(next) {
      project = next
      projectCb?.(next)
    },
    emitGateProgress(e) {
      gateCb?.(e)
    },
    calls,
    reports,
  }
}

const INITIAL = useStore.getState()

function install(fake: Fake): void {
  const g = globalThis as { window?: unknown }
  g.window = { circletake: fake.api }
}

beforeEach(() => {
  useStore.setState({
    project: null,
    projectPath: null,
    recents: [],
    loading: true,
    room: 'bin',
    selectedShotId: null,
    selectedTakeId: null,
    compareTakeId: null,
    wipe: null,
    syncPlayheads: true,
    playhead: 0,
    playing: false,
    engineStatus: IDLE_ENGINE,
    gateProgress: {},
    reports: {},
    reportTakeId: null,
    ratesOpen: false,
    toast: null,
  })
})

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------

describe('defaults', () => {
  it('starts in the Bin with nothing selected and no compare', () => {
    expect(INITIAL.room).toBe('bin')
    expect(INITIAL.wipe).toBeNull()
    expect(INITIAL.compareTakeId).toBeNull()
    expect(INITIAL.engineStatus).toEqual(IDLE_ENGINE)
  })
})

describe('pure UI actions (no bridge required)', () => {
  it('switches rooms', () => {
    useStore.getState().setRoom('print')
    expect(useStore.getState().room).toBe('print')
  })

  it('toggles compare off when the same take is picked twice', () => {
    const { setCompare } = useStore.getState()
    setCompare('t2')
    expect(useStore.getState().compareTakeId).toBe('t2')
    setCompare('t2')
    expect(useStore.getState().compareTakeId).toBeNull()
  })

  it('switches compare to a different take', () => {
    const { setCompare } = useStore.getState()
    setCompare('t2')
    setCompare('t3')
    expect(useStore.getState().compareTakeId).toBe('t3')
  })

  it('toggles wipe mode between side-by-side and a centred wipe', () => {
    const { toggleWipeMode } = useStore.getState()
    expect(useStore.getState().wipe).toBeNull()
    toggleWipeMode()
    expect(useStore.getState().wipe).toBe(0.5)
    toggleWipeMode()
    expect(useStore.getState().wipe).toBeNull()
  })

  it('opens and closes the report and rates overlays', () => {
    useStore.getState().openReport('t1')
    expect(useStore.getState().reportTakeId).toBe('t1')
    useStore.getState().openReport(null)
    expect(useStore.getState().reportTakeId).toBeNull()

    useStore.getState().setRatesOpen(true)
    expect(useStore.getState().ratesOpen).toBe(true)
  })

  it('is a no-op (not a crash) when no bridge is installed', async () => {
    await useStore.getState().circleTake('t1', true)
    await useStore.getState().runGate('t1')
    await useStore.getState().exportAs('edl')
    expect(useStore.getState().project).toBeNull()
  })
})

describe('init', () => {
  it('mirrors the project and selects the first shot in cut order', async () => {
    const fake = makeFake()
    install(fake)
    await useStore.getState().init()

    const s = useStore.getState()
    expect(s.loading).toBe(false)
    expect(s.project?.name).toBe('FIXTURE')
    expect(s.projectPath).toBe('/films/Fixture.ctake')
    expect(s.recents).toHaveLength(1)
    expect(s.engineStatus.ready).toBe(true)
    // s1 has order 0 even though s2 comes first in the array.
    expect(s.selectedShotId).toBe('s1')
  })

  it('records gate progress pushed from main', async () => {
    const fake = makeFake()
    install(fake)
    await useStore.getState().init()

    fake.emitGateProgress({ takeId: 't1', stage: 'optical flow', pct: 40 })
    expect(useStore.getState().gateProgress.t1).toEqual({ stage: 'optical flow', pct: 40 })
  })

  it('drops selections that no longer exist after a project update', async () => {
    const fake = makeFake()
    install(fake)
    await useStore.getState().init()
    useStore.setState({ selectedShotId: 's1', selectedTakeId: 't2', compareTakeId: 't3' })

    const pruned: Project = {
      ...fake.project,
      shots: [shot('s1', '12', 0)],
      takes: [take('t1', 's1')],
    }
    fake.emitProject(pruned)

    const s = useStore.getState()
    expect(s.selectedShotId).toBe('s1')
    expect(s.selectedTakeId).toBeNull()
    expect(s.compareTakeId).toBeNull()
  })

  it('keeps selections that survive a project update', async () => {
    const fake = makeFake()
    install(fake)
    await useStore.getState().init()
    useStore.setState({ selectedShotId: 's1', selectedTakeId: 't1', compareTakeId: 't2' })

    fake.emitProject({ ...fake.project, name: 'RENAMED' })

    const s = useStore.getState()
    expect(s.project?.name).toBe('RENAMED')
    expect(s.selectedTakeId).toBe('t1')
    expect(s.compareTakeId).toBe('t2')
  })
})

describe('navigation', () => {
  it('openShot jumps to the Village on the shot’s best take and clears compare', async () => {
    const fake = makeFake()
    install(fake)
    await useStore.getState().init()
    useStore.setState({ compareTakeId: 't3', playhead: 4, playing: true })

    useStore.getState().openShot('s1')

    const s = useStore.getState()
    expect(s.room).toBe('village')
    expect(s.selectedShotId).toBe('s1')
    expect(s.selectedTakeId).toBe('t1') // 91 beats 74
    expect(s.compareTakeId).toBeNull()
    expect(s.playhead).toBe(0)
    expect(s.playing).toBe(false)
  })

  it('selectShot picks the shot’s best take without leaving the room', async () => {
    const fake = makeFake()
    install(fake)
    await useStore.getState().init()

    useStore.getState().selectShot('s2')
    expect(useStore.getState().room).toBe('bin')
    expect(useStore.getState().selectedTakeId).toBe('t3')
  })

  it('selectShot(null) clears the take selection', async () => {
    const fake = makeFake()
    install(fake)
    await useStore.getState().init()
    useStore.getState().selectShot(null)
    expect(useStore.getState().selectedTakeId).toBeNull()
  })
})

describe('mutations through the bridge', () => {
  it('toggleCircle flips the take and refreshes the mirror', async () => {
    const fake = makeFake()
    install(fake)
    await useStore.getState().init()

    await useStore.getState().toggleCircle('t1')
    expect(useStore.getState().project?.takes.find((t) => t.id === 't1')?.circled).toBe(true)

    await useStore.getState().toggleCircle('t1')
    expect(useStore.getState().project?.takes.find((t) => t.id === 't1')?.circled).toBe(false)
  })

  it('toggleCircle on an unknown take does nothing', async () => {
    const fake = makeFake()
    install(fake)
    await useStore.getState().init()
    await useStore.getState().toggleCircle('nope')
    expect(fake.calls.filter((c) => c === 'circleTake')).toHaveLength(0)
  })

  it('runGate seeds a progress entry and invalidates the cached report', async () => {
    const fake = makeFake()
    install(fake)
    await useStore.getState().init()
    useStore.setState({ reports: { t1: null } })

    await useStore.getState().runGate('t1')

    expect(fake.calls).toContain('runGate:t1')
    expect(useStore.getState().gateProgress.t1?.stage).toBe('queued')
    expect('t1' in useStore.getState().reports).toBe(false)
  })

  it('ingestPaths reports what landed and what was skipped', async () => {
    const fake = makeFake()
    install(fake)
    await useStore.getState().init()

    await useStore.getState().ingestPaths(['/inbox/a.mp4', '/inbox/bad.txt'])
    expect(useStore.getState().toast).toBe('Ingested 2 files · 1 skipped')
  })

  it('ingestPaths with no paths never calls the bridge', async () => {
    const fake = makeFake()
    install(fake)
    await useStore.getState().init()
    await useStore.getState().ingestPaths([])
    expect(fake.calls).not.toContain('ingestFiles')
  })

  it('setModelRates stores the card and closes the editor', async () => {
    const fake = makeFake()
    install(fake)
    await useStore.getState().init()
    useStore.setState({ ratesOpen: true })

    await useStore.getState().setModelRates({ 'veo-3.1-cine': 1.2 })

    const s = useStore.getState()
    expect(s.ratesOpen).toBe(false)
    expect(s.project?.settings.modelRates).toEqual({ 'veo-3.1-cine': 1.2 })
    expect(s.toast).toBe('Rate card updated')
  })

  it('exportAs routes to the right writer and toasts the path', async () => {
    const fake = makeFake()
    install(fake)
    await useStore.getState().init()

    await useStore.getState().exportAs('fcpxml')
    expect(fake.calls).toContain('exportFcpxml')
    expect(useStore.getState().toast).toBe('Wrote /out/selects.fcpxml')

    await useStore.getState().exportAs('reshoot')
    expect(fake.calls).toContain('exportReshootList')
    expect(useStore.getState().toast).toBe('Wrote /out/reshoots.md')
  })
})

describe('gate reports + suggested windows', () => {
  const report: GateReport = {
    takeId: 't1',
    mediaPath: '/media/t1.mp4',
    engineVersion: '1.0.0',
    modelVersions: {},
    ranAt: '2026-07-22T00:00:00.000Z',
    overall: 91,
    status: 'pass',
    checks: {},
    suggestedWindow: { inSec: 1.2, outSec: 4.8, reason: 'cleanest continuous span' },
  }

  it('caches a loaded report', async () => {
    const fake = makeFake()
    fake.reports.set('t1', report)
    install(fake)
    await useStore.getState().init()

    await useStore.getState().loadReport('t1')
    expect(useStore.getState().reports.t1?.overall).toBe(91)
  })

  it('caches a null for takes with no report so it is not refetched forever', async () => {
    const fake = makeFake()
    install(fake)
    await useStore.getState().init()

    await useStore.getState().loadReport('t9')
    expect('t9' in useStore.getState().reports).toBe(true)
    expect(useStore.getState().reports.t9).toBeNull()
  })

  it('applySuggestedWindow loads the report then writes the window', async () => {
    const fake = makeFake()
    fake.reports.set('t1', report)
    install(fake)
    await useStore.getState().init()

    await useStore.getState().applySuggestedWindow('t1')

    expect(fake.calls).toContain('getGateReport:t1')
    expect(fake.calls).toContain('setTakeWindow:t1:1.2:4.8')
    expect(useStore.getState().toast).toBe('Select window applied — 1.2s → 4.8s')
  })

  it('applySuggestedWindow is a no-op when the gate suggested nothing', async () => {
    const fake = makeFake()
    fake.reports.set('t1', { ...report, suggestedWindow: undefined })
    install(fake)
    await useStore.getState().init()

    await useStore.getState().applySuggestedWindow('t1')
    expect(fake.calls.some((c) => c.startsWith('setTakeWindow'))).toBe(false)
  })
})
