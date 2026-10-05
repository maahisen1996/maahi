const fs = require("fs");
const path = require("path");

module.exports = function handler(_req, res) {
  try {
    const b64 = fs
      .readFileSync(path.join(process.cwd(), "media", "mahi-intro.b64"), "utf8")
      .trim();

    const image = Buffer.from(b64, "base64");

    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.status(200).send(image);
  } catch (error) {
    res.status(500).json({ error: "Unable to load image" });
  }
};
