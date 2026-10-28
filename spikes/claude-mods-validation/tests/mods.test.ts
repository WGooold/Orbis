import { expect, test } from 'claude-code/testing'

test('observes prompt and tool events and exposes them through a registered command', async ($, on) => {
  let submittedText = ''
  on('prompt.submit', (_$, event) => {
    submittedText = event.text
    return { text: event.text }
  })
  on('tool.call', () => ({ result: 'probe result' }))

  // The testing kit dispatches engine events, so provide engine-owned fields.
  await $.prompt.submit({ text: 'local plugin test probe', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Bash', command: 'echo probe' })
  const command = await $.command.run({
    command: 'orbis-mod-probe', args: '', origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(submittedText).toBe('local plugin test probe')
  expect(command.text).toBe('Observed 2 prompt and tool events in this mod instance')
})
