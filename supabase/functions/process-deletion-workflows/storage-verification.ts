type StorageInfoResult = {
  data: unknown;
  error: { status?: number } | null;
};

export async function storageObjectExistsByInfo(
  objectPath: string,
  info: (path: string) => Promise<StorageInfoResult>,
): Promise<boolean> {
  const { data, error } = await info(objectPath);
  if (error) {
    if (error.status === 404) return false;
    throw new Error("storage_verification_failed");
  }
  if (data == null) throw new Error("storage_verification_failed");
  return true;
}
