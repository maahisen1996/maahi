const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";

async function driveList(accessToken, params) {
  const response = await fetch(`${DRIVE_API}?${new URLSearchParams(params).toString()}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google Drive error ${response.status}: ${text}`);
  return JSON.parse(text).files || [];
}

export async function listGoogleDriveFilesWithToken(env, accessToken) {
  return driveList(accessToken, {
    q: `'${env.GOOGLE_DRIVE_FOLDER_ID}' in parents and trashed = false`,
    fields: "files(id,name,mimeType,size,modifiedTime)",
    orderBy: "name",
    pageSize: "100",
  });
}

export async function listGoogleDriveFolderWithToken(folderId, accessToken) {
  return driveList(accessToken, {
    q: `'${folderId}' in parents and trashed = false`,
    fields: "files(id,name,mimeType,size,modifiedTime)",
    orderBy: "name",
    pageSize: "1000",
  });
}

export async function findChildFolderWithToken(parentId, folderName, accessToken) {
  const children = await listGoogleDriveFolderWithToken(parentId, accessToken);
  const found = children.find(
    (f) => f.mimeType === FOLDER_MIME && f.name.toLowerCase() === folderName.toLowerCase()
  );
  if (!found) throw new Error(`Drive folder not found under root: ${folderName}`);
  return found;
}

function stemFromName(name) {
  return name.replace(/\.(jpe?g|png|webp|txt)$/i, "");
}

function isImage(file) {
  return /^image\//i.test(file.mimeType || "") || /\.(jpe?g|png|webp)$/i.test(file.name || "");
}

function isCaption(file) {
  return file.mimeType === "text/plain" || /\.txt$/i.test(file.name || "");
}

export async function buildDriveQueueWithToken(env, accessToken) {
  const rootChildren = await listGoogleDriveFolderWithToken(env.GOOGLE_DRIVE_FOLDER_ID, accessToken);
  const imagesFolder = rootChildren.find(
    (f) => f.mimeType === FOLDER_MIME && f.name.toLowerCase() === "images"
  );
  const captionsFolder = rootChildren.find(
    (f) => f.mimeType === FOLDER_MIME && f.name.toLowerCase() === "captions"
  );

  if (!imagesFolder) throw new Error("Drive Images folder not found");
  if (!captionsFolder) throw new Error("Drive Captions folder not found");

  const [images, captions] = await Promise.all([
    listGoogleDriveFolderWithToken(imagesFolder.id, accessToken),
    listGoogleDriveFolderWithToken(captionsFolder.id, accessToken),
  ]);

  const captionByStem = new Map();
  for (const file of captions) {
    if (!isCaption(file)) continue;
    captionByStem.set(stemFromName(file.name).toLowerCase(), file);
  }

  const queue = [];
  for (const image of images) {
    if (!isImage(image)) continue;
    const stem = stemFromName(image.name);
    const caption = captionByStem.get(stem.toLowerCase());
    if (!caption) continue;
    queue.push({
      stem,
      imageId: image.id,
      imageName: image.name,
      imageMimeType: image.mimeType || "image/jpeg",
      captionId: caption.id,
      captionName: caption.name,
    });
  }

  return queue.sort((a, b) => a.stem.localeCompare(b.stem));
}

export async function downloadGoogleDriveFileWithToken(fileId, accessToken) {
  const response = await fetch(
    `${DRIVE_API}/${encodeURIComponent(fileId)}?alt=media`,
    { headers: { authorization: `Bearer ${accessToken}` } }
  );
  if (!response.ok) {
    throw new Error(`Google Drive download error ${response.status}: ${await response.text()}`);
  }
  return response;
}

export async function readGoogleDriveTextWithToken(fileId, accessToken) {
  const response = await downloadGoogleDriveFileWithToken(fileId, accessToken);
  return (await response.text()).trim();
}
