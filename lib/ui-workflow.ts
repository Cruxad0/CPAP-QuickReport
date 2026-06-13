export function shouldClearPatientDetailsForSourceImport({
  sourceFileCount,
  loadedSourceLoader,
  hasGeneratedReports
}: {
  sourceFileCount: number;
  loadedSourceLoader: string | null;
  hasGeneratedReports: boolean;
}) {
  return sourceFileCount > 0 || loadedSourceLoader !== null || hasGeneratedReports;
}
