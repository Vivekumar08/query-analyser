export function safeUpstreamMessage(status: number, kind: 'org' | 'app' | 'generic'): string {
  if (status === 409 && kind === 'app') return 'An app with that name already exists in this workspace.';
  if (status === 409 && kind === 'org') return 'That workspace name is taken — try another.';
  if (status === 400) return 'Please check the name and try again.';
  if (status === 403) return "You don't have permission to do that.";
  if (status === 429) return 'Too many attempts — wait a minute and try again.';
  return 'Something went wrong. Please try again.';
}
