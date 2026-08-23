# Gems app preview

This is a standalone, framework-free mobile web app containing the splash,
login, account-creation, Home, Discover, Photos, Editor, and Profile/Gems Plus
experiences.

Run it from this directory:

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Then open <http://localhost:8080>.

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/srikanthvishnu90-sketch/photos)

When importing manually, use the `Other` framework preset and leave the build
and output-directory settings empty. The repository root is the deployable site.
