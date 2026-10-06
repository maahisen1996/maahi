export async function listGoogleDriveFilesWithToken(env, accessToken) {
  const params = new URLSearchParams({
    q: `'${env.GOOGLE_DRIVE_FOLDER_ID}' in parents and trashed = false`,
    fields: "files(id,name,mimeType,size,modifiedTime)",
    orderBy: "name",
    pageSize: "100",
  });

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Google Drive error ${response.status}: ${text}`);
  }

  return JSON.parse(text).files || [];
}

export async function downloadGoogleDriveFileWithToken(fileId, accessToken) {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Google Drive download error ${response.status}: ${await response.text()}`);
  }

  return response;
}
