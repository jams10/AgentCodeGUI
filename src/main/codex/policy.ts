import type { ModeId } from '@shared/protocol'

export type CodexApprovalPolicy = string | {
  granular: { sandbox_approval: boolean; rules: boolean; mcp_elicitations: boolean; request_permissions: boolean; skill_approval: boolean }
}

/** Automatic local execution must not silently decline a service's consent form. */
export function codexPolicy(mode: ModeId): { approvalPolicy: CodexApprovalPolicy; sandbox: string } {
  switch (mode) {
    case 'plan': return { approvalPolicy: 'on-request', sandbox: 'read-only' }
    case 'acceptEdits': return { approvalPolicy: 'on-request', sandbox: 'workspace-write' }
    case 'auto':
    case 'bypass':
      return {
        approvalPolicy: { granular: { sandbox_approval: false, rules: false, mcp_elicitations: true, request_permissions: false, skill_approval: false } },
        sandbox: mode === 'bypass' ? 'danger-full-access' : 'workspace-write'
      }
    default: return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' }
  }
}
