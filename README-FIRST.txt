GEORGE RUMP SITE - HOW IT WORKS NOW
(comd.txt and your git / Cloudflare steps are NOT changed.)

ONE DATA SOURCE: the XnView .xmp files beside your photos in  collections\
  Both XnView and the floating window can read and write them.
  No image-metadata.json. No other copy of the data.

FILES (all go in WEB.300)
  index.html            the website
  registry.js           made by generateRegistry.js (do not edit by hand)
  generateRegistry.js   reads photos + .xmp -> registry.js     (comd.txt step 1)
  save-server.js        local helper for the floating window   (comd.txt step 4)
  xmp-tools.js          the only code that reads/writes .xmp (needed by both)
  import-old-data-to-xmp.js   run ONCE to keep your old titles/colours
  palette.json          your named colours (made by the window; edit there)

FLOATING WINDOW (only on http://localhost:8000 with the save server running)
  Filename     renaming also renames the .xmp
  Title, Description
  Link colour  pick a named colour from your palette, or Custom colour.
               Saved as a keyword:  link:Sunset  (a name)  or  link:#c07b21
               Choose "No colour" to remove it (then the XnView label is used)
  Colour palette (open it under the Save button):
               add a colour = pick a shade + type a name
               change a shade = every photo with that name follows at once
               rename = every photo is moved to the new name
               "Name it" = turn an exact #colour already on photos into a name
               You cannot delete a colour that photos still use.
  The window reads the .xmp fresh when you open a photo and when you click back
  into the page. It never overwrites unsaved typing. If XnView changed the SAME
  field since you opened it, the save is refused and the new value is shown.
  After a rename the page reloads (registry.js is rebuilt automatically).

COLOUR RULE
  The link: keyword wins (a palette name or a #rrggbb). If there is none,
  the XnView colour label is used. In XnView the Categories panel lists the
  link: keywords with a count, so you can click one to see those photos.
  Edit the 9 label shades at the top of xmp-tools.js.

RETURN HOME PICTURES
  Put pictures in  assets\home  (any file names). Each page load shows the next one
  in name order (return-icon2 comes before return-icon10), then starts again.
  Types that work: png apng jpg jpeg gif (animated) webp (animated) avif svg ico cur bmp
  Windows animated cursors (.ani) work too: generateRegistry.js makes an animated PNG
  copy in  assets\home-converted  (the original .ani is never changed; leave that
  folder alone - it is rebuilt automatically and is published with the site).
  Not possible in a web page: .tif .heic .xpm .rle  (convert to .gif .png or .webp)
  After adding or removing pictures run:  node .\generateRegistry.js
  If assets\home is empty the site keeps using assets\return-icon.png.

PUBLIC SITE: read-only. It never contacts the save server. It does not show
  the Filename or File size lines (the local editor on port 8000 does).

KEEP IN MIND
  .xmp files are published with git push. Keep XnView contact/creator fields empty.
  Keep backups OUTSIDE WEB.300 (git add -A includes everything).
  Folder must be named  collections  (all lowercase).
