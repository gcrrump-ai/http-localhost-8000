GEORGE RUMP PHOTOGRAPHY — FLAT COLLECTION + IMAGE METADATA UPDATE

WHAT THIS UPDATE DOES
- Uses one flat gallery folder: WEB.300\collections\
- Leaves collections\Icons\ and reserved folders untouched.
- Removes folder grouping from gallery navigation; all images appear as one continuous list.
- Preserves the existing viewer, navigation keys/swipe, floating window, toolbar, magnifier, dark mode, expand mode, welcome text, and current layout.
- Moves existing images from collection subfolders into collections\ and records their former folder in Original folder.
- Preserves existing custom titles and descriptions in image-metadata.json.
- Adds file details (filename, format, size, modified date, dimensions, and readable JPEG EXIF details).
- Title, Description, and Original folder can be edited in the floating window and saved to image-metadata.json by the local server. Technical file information is read-only.
- The existing POST /save configuration endpoint is retained in save-server.js.

FILES
- index.html                  Updated flat-list viewer and metadata panel
- style.css                   Only flat-list and metadata-field styling additions/selector changes
- generate-registry.js        Rebuilds registry from images directly in collections\
- migrate-to-flat-collections.js  One-time migration of existing subfolder images
- save-server.js              Existing server plus GET /metadata and POST /save-metadata

IMPORTANT FIRST RUN
1. Make a backup copy of your WEB.300 folder before migrating images.
2. Replace index.html and style.css with the supplied files.
3. Replace generate-registry.js and save-server.js with the supplied files.
4. Put migrate-to-flat-collections.js in WEB.300.
5. From PowerShell, run:
   cd "C:\Users\user\Desktop\WEB.300"; node .\migrate-to-flat-collections.js
   This moves eligible image files from subfolders to collections\. It skips Icons, homepage, Thumbs, and imgStrip folders. It verifies each copy before deleting its source.
6. Start/restart the local metadata save server in a separate PowerShell window:
   cd "C:\Users\user\Desktop\WEB.300"; node .\save-server.js
7. Start your normal website server as you usually do and refresh the page.

FUTURE IMAGES
- Add new gallery images directly into WEB.300\collections\
- Then run:
  cd "C:\Users\user\Desktop\WEB.300"; node .\generate-registry.js
- Refresh the website. The local save server automatically creates metadata records for new files.

NOTES
- New images have a blank Original folder until you enter one in the floating window.
- EXIF information appears only when it exists in the image file. Many edited/scanned/exported images may not contain EXIF.
- Editing metadata never alters the image file itself.
- Metadata is keyed by the image file's SHA-256 content hash, so renaming/moving a file will not detach its metadata. Reprocessing the image bytes creates a new identity.
