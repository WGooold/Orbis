import type { Hook, Register } from 'claude-code'

type Api = Parameters<Hook<'session.start'>>[0]
type Row = { event: string; [key: string]: unknown }

let observed = 0
let activeTurn: string | undefined
let lastTurn: string | undefined
let abortNext = false
let queueNext = false
const events: Row[] = []

function record(event: string, data: Record<string, unknown> = {}) {
  events.push({ event, ...data })
  if (events.length > 128) events.shift()
}

async function submit($: Api, text: string) {
  record('submit.request')
  try {
    const result = await $.prompt.submit({ text, asUser: true })
    record('submit.return', { accepted: !('drop' in result) })
  } catch {
    record('submit.error')
  }
}

async function abort($: Api, turnId: string) {
  record('abort.request', { turnId })
  try {
    await $.turn.abort({ turnId })
    record('abort.return', { turnId })
  } catch {
    record('abort.error', { turnId })
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, event, next) => {
    record('session.start', { interactive: event.isInteractive })
    await $.command.register({
      name: 'orbis-mod-probe',
      description: 'Local Claude Code compatibility probe',
      argumentHint: '[status|submit|tool|read-probe|abort|stale-abort|queue]',
      immediate: true,
    })
    return next(event)
  })

  // Observers always pass the native event through, including on hook failure.
  on('prompt.submit', ($, event, next) => {
    observed += 1
    record('prompt.submit', {
      origin: event.origin.kind,
      asUser: 'asUser' in event.origin ? event.origin.asUser : undefined,
      wait: event.wait,
      turnId: event.turnId,
    })
    return next(event)
  }).catch(($, event, next) => next(event))

  on('tool.call', ($, event, next) => {
    observed += 1
    record('tool.call', { tool: event.tool, toolUseId: event.tool_use_id })
    return next(event)
  }).catch(($, event, next) => next(event))

  on('session.append', ($, event, next) => {
    record('session.append', {
      door: event.door, uuid: event.uuid, type: event.message.type,
      origin: event.origin.kind,
      asUser: 'asUser' in event.origin ? event.origin.asUser : undefined,
    })
    return next(event)
  }).catch(($, event, next) => next(event))

  on('turn.start', ($, event, next) => {
    record('turn.start', { turnId: event.turnId, agentId: event.agentId })
    if (event.agentId === undefined) {
      activeTurn = event.turnId
      lastTurn = event.turnId
      if (abortNext) {
        abortNext = false
        $.clock.after(800, () => { void abort($, event.turnId) })
      }
      if (queueNext) {
        queueNext = false
        $.clock.after(200, () => { void submit($, 'Reply exactly ORBIS_QUEUE_OK. Do not use tools.') })
      }
    }
    return next(event)
  })

  on('turn.complete', ($, event, next) => {
    record('turn.complete', {
      turnId: event.turnId,
      agentId: event.agentId,
      reason: event.reason,
      isAborted: event.isAborted,
      hasAnswer: event.answer.length > 0,
      answerMatchesProbe: /^ORBIS_(NATIVE|QUEUE)_OK[.!。]?\s*$/.test(event.answer.trim()),
    })
    if (event.agentId === undefined && activeTurn === event.turnId) activeTurn = undefined
    return next(event)
  })

  on('command.run', { command: 'orbis-mod-probe' }, async ($, event) => {
    const action = event.args.trim()
    if (!action) return { text: `Observed ${observed} prompt and tool events in this mod instance` }
    if (action === 'status') {
      const messages = await $.session.messages()
      const status = {
        sessionId: await $.session.id(),
        version: await $.session.version(),
        model: await $.session.model(),
        toolNames: (await $.tool.list()).map(tool => tool.name),
        activeTurn,
        observed,
        messageCount: messages.length,
        lastMessageRole: messages.at(-1)?.role,
        events,
      }
      const text = JSON.stringify(status, null, 2)
      // Only metadata and fixed-probe assertions; no prompts, replies or credentials.
      await $.fs.write(`${$.plugin.root}/.claude-plugin/.cache/native.json`, text)
      return { text }
    }
    if (action === 'stale-abort') {
      await abort($, lastTurn ?? 'orbis-nonexistent-turn')
      return { text: 'Stale abort result recorded; inspect status.' }
    }
    if (action === 'read-probe') {
      try {
        const result = await $.tool.call({
          tool: 'Read', file_path: `${$.plugin.root}/.claude-plugin/plugin.json`,
        })
        record('direct-tool.return', { hasText: (result.text?.length ?? 0) > 0 })
        return { text: 'Native Read call returned; inspect status.' }
      } catch {
        record('direct-tool.error')
        return { text: 'Native Read call rejected; inspect status.' }
      }
    }
    if (action === 'submit' || action === 'tool' || action === 'abort' || action === 'queue') {
      if (activeTurn !== undefined) return { text: 'Probe refused: a turn is already active.' }
      abortNext = action === 'abort'
      queueNext = action === 'queue'
      const text = action === 'tool'
        ? 'Use the Read tool to read spikes/claude-mods-validation/.claude-plugin/plugin.json, then reply exactly ORBIS_NATIVE_OK. Do not use other tools.'
        : 'Reply exactly ORBIS_NATIVE_OK. Do not use tools.'
      $.clock.after(200, () => { void submit($, text) })
      return { text: `Scheduled ${action} probe through the public Mods API.` }
    }
    return { text: 'Unknown probe action.' }
  }).catch(() => ({ text: 'Probe command failed.' }))
}
