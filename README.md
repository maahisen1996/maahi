# Mahi Instagram Automation

This repository is the publishing bridge for Mahi's Instagram account.

## Intended flow

1. ChatGPT generates the day's Mahi image and caption.
2. The image is made available at a public HTTPS URL.
3. ChatGPT updates `content.json` with the image URL and caption.
4. GitHub Actions calls Instagram's Content Publishing API.
5. Instagram publishes the post.

## Important limitation discovered during setup

GitHub's connector can create/update text and Git objects, including base64 blobs, but ChatGPT's image-generation result is not currently exposed to the GitHub connector as raw image bytes. Therefore this repository cannot, by itself, turn a ChatGPT-generated image into a public image URL with zero additional media-transfer step.

The repository is nevertheless set up so that once a public image URL is available, publishing can be fully automated.

## GitHub secrets

Add these repository secrets:

- `INSTAGRAM_ACCESS_TOKEN`: a valid Meta/Instagram Graph API access token with permission to publish media.
- `INSTAGRAM_USER_ID`: the Instagram professional-account ID. For Mahi this is currently `17841424446542500`.

## Content file

Example:

```json
{
  "image_url": "https://example.com/mahi.jpg",
  "caption": "Kolkata girl, California chapter. 🌙"
}
```

Changing `content.json` triggers the publishing workflow.

## Safety

The workflow intentionally publishes only when `content.json` changes. This prevents a GitHub scheduled job from accidentally reposting the same image every day.
