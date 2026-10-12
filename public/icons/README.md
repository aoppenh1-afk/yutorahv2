# Home screen icons

`yutorah-app.svg` is the master for the installed app icon. Its 66 shield paths
come from page 1 of the official [2025 RIETS Evening of Tribute publication](https://www.yu.edu/sites/default/files/inline-files/5978%20RIETS%20Dinner%20SM%20Graphics22_0.pdf).
The shield's lettering and proportions are preserved, using the publication's
white artwork on a solid navy background, `#123e65`.

Export each PNG directly from this vector, with an opaque, square background:

- `../apple-touch-icon.png`: 180 × 180 for iOS.
- `yutorah-192.png`: 192 × 192 for the web app manifest and notifications.
- `yutorah-512.png`: 512 × 512 for the web app manifest.

The operating system applies its own corner mask. Keep rounded corners out of
the exported assets. Do not enlarge `../images/yutorah-shield.png` to generate
these icons; that source is only 72 × 68 pixels.

The icon URLs in `app/layout.tsx` and `public/manifest.webmanifest` include a
version query to refresh cached downloads. Existing iOS home screen installs
may require removing and adding the shortcut again after deployment.
