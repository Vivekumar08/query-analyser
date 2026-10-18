export function buildSnippet(key: string, appName: string): { install: string; code: string } {
  return {
    install: 'npm install @vivekumar08/query-analyser',
    code: [
      `require('@vivekumar08/query-analyser').init({`,
      `  apiKey: ${JSON.stringify(key)},`,
      `  app: ${JSON.stringify(appName)},`,
      `});`,
    ].join('\n'),
  };
}
