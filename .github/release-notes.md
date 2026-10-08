## Download

| System | File |
|---|---|
| Windows (most PCs) | `Binder-…-win-x64.exe` |
| Windows on ARM (Snapdragon laptops, Surface Pro X …) | `Binder-…-win-arm64.exe` |
| Linux, any distribution | `Binder-…-linux-x86_64.AppImage` (or `…-arm64.AppImage`) |
| Debian / Ubuntu / Mint | `Binder-…-linux-amd64.deb` (or `…-arm64.deb`) |

**Windows:** the installer isn't code-signed, so SmartScreen may warn you. Click **More info → Run anyway**.

**Linux AppImage:** make it executable first: `chmod +x Binder-*.AppImage`, then run it.

Your files stay in normal folders in `Documents`. Binder's own data (homework, notes, pins …) is in `%APPDATA%\Binder` on Windows and `~/.config/Binder` on Linux.
