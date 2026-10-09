# Windows packaging notes

The application release version is read from `apps/desktop/package.json`. The staged manifest and NSIS product metadata use that version; the installer artifact name includes it. The display name remains `MAGINALIA desktop α1`.

## Optional Desktop shortcut

The Desktop shortcut is unchecked by default. If `MAGINALIA desktop α1.lnk` already exists when the installer runs, including during an upgrade or reinstall, the installer preserves it and reports that it did not add another shortcut.

The installer cannot reliably tell whether a same-name shortcut was replaced after installation. It therefore does not delete the optional Desktop shortcut during uninstall. A shortcut created by MAGINALIA can remain and may be stale after uninstall; the user can remove it from the Desktop. The Start Menu shortcut remains installer-managed.
