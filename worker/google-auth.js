// Google service-account authentication adapter.
// The Drive client is already implemented in ./google-drive.js.
//
// This function is intentionally a small integration boundary so the caller
// only needs to supply a short-lived Google OAuth access token.
export async function getGoogleDriveAccessToken(_env) {
  throw new Error("Google Drive auth helper is not configured yet");
}
