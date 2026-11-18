GEORGE RUMP WEBSITE — REPLACEMENT FILES
Baseline: the saved working per-image Link colour update, with the later confirmed move of toolbar icons to assets/ and the flat Collections path corrections.

CONTENTS
- index.html
- style.css
- registry.js
- generateRegistry.js
- save-server.js

INSTALL
1. Stop the local save server (Ctrl+C in its PowerShell window).
2. Back up your existing WEB.300 folder.
3. Extract these five files into WEB.300 and replace the matching files.
4. KEEP your existing Collections folder, assets folder, and image-metadata.json. Do not replace or move them.
5. In PowerShell, run:
   cd "C:\Users\user\Desktop\WEB.300"; node .\generateRegistry.js
6. Start the metadata save server:
   cd "C:\Users\user\Desktop\WEB.300"; node .\save-server.js
7. Refresh the website.

FOLDER EXPECTATIONS
- All photographs are directly inside WEB.300\Collections\.
- Existing .txt files may remain directly inside Collections; the generator ignores them.
- Toolbar icons remain in WEB.300\assets\ with these filenames:
  magnifier-icon.png, dark-icon.png, light-icon.png
- Do not create Collections subfolders or restore an Icons folder.
- image-metadata.json is your local saved editing data; keep it.

NOTES
- The index.html, style.css and save-server.js come from the known Link colour baseline.
- The index's three toolbar icon paths are updated to assets/.
- The gallery path check and save server now use Collections (capital C).
- generateRegistry.js scans only image files directly inside Collections and preserves custom title/description entries from registry.js.
- This package does not include or replace photographs, icons, or your local metadata database.
