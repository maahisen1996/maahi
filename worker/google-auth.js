function base64Url(input) {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : new Uint8Array(input);

  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function pemToArrayBuffer(pem) {
  if (!pem || typeof pem !== "string") {
    throw new Error("GOOGLE_PRIVATE_KEY is missing or not a string");
  }

  let normalized = pem.trim();

  // Accept either the raw private_key value, a JSON-quoted private_key string,
  // or (accidentally) the entire service-account JSON object.
  try {
    if (normalized.startsWith("{")) {
      const obj = JSON.parse(normalized);
      if (obj?.private_key) normalized = obj.private_key;
    } else if (normalized.startsWith('"') && normalized.endsWith('"')) {
      normalized = JSON.parse(normalized);
    }
  } catch (_) {
    normalized = normalized.replace(/^"|"$/g, "");
  }

  normalized = normalized.replace(/\\n/g, "\n").trim();

  const match = normalized.match(
    /-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END PRIVATE KEY-----/
  );

  let clean;
  if (match) {
    clean = match[1].replace(/\s+/g, "");
  } else {
    clean = normalized
      .replace(/-----BEGIN PRIVATE KEY-----/g, "")
      .replace(/-----END PRIVATE KEY-----/g, "")
      .replace(/\s+/g, "");
  }

  if (!clean || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
    throw new Error(
      "GOOGLE_PRIVATE_KEY format is invalid. Paste the private_key value from the Google JSON key, including BEGIN/END PRIVATE KEY markers."
    );
  }

  while (clean.length % 4 !== 0) clean += "=";

  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

export async function getGoogleDriveAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const payload = {
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const unsignedJwt =
    `${base64Url(JSON.stringify(header))}.` +
    `${base64Url(JSON.stringify(payload))}`;

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(env.GOOGLE_PRIVATE_KEY),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsignedJwt)
  );

  const assertion = `${unsignedJwt}.${base64Url(signature)}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Google token error ${response.status}: ${text}`);
  }

  return JSON.parse(text).access_token;
}
