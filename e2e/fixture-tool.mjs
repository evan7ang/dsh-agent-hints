// SPDX-License-Identifier: MulanPSL-2.0
// Minimal tool-provider fixture for the keyless wire e2e (run.sh): registers
// one echo tool so the capture stub can drive a real tool round trip through
// the hinted adapter. Plain JS, no build step — mounted straight from source
// by the e2e patch overlay. Named exports only (DSH Loader constraint).
export const name = 'dsh-agent-hints-e2e-probe'

export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register({
    name: 'e2e_probe',
    description: 'E2E probe tool: echoes the message argument back. Only used by the dsh-agent-hints wire e2e.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message to echo back.' },
      },
      required: ['message'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          echo: { type: 'string' },
        },
        required: ['echo'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      return { echo: String(args?.message ?? '') }
    },
  })
}
