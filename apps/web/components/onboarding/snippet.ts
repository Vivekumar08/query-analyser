export function buildSnippet(
  key: string,
  appName: string,
): { install: string; code: string; driverCode: string } {
  return {
    install: 'npm install @vivekumar08/query-analyser',
    code: [
      `// Call this before your app connects to its database.`,
      `require('@vivekumar08/query-analyser').init({`,
      `  apiKey: ${JSON.stringify(key)},`,
      `  app: ${JSON.stringify(appName)},`,
      `});`,
    ].join('\n'),
    driverCode: [
      `// Using the mongodb driver directly? Pass your client too:`,
      `const client = new MongoClient(process.env.MONGODB_URI, { monitorCommands: true });`,
      `require('@vivekumar08/query-analyser').init({ apiKey: process.env.QA_KEY, app: ${JSON.stringify(appName)}, mongoClient: client });`,
    ].join('\n'),
  };
}
