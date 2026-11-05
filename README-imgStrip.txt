IMAGE STRIP SETUP

1. Keep the imgStrip folder beside index.html.
2. Add image files directly inside imgStrip (jpg, jpeg, png, gif, webp or avif).
3. The newest file appears at the top of the vertical strip.

AUTOMATIC LOCAL UPDATES
On Windows, double-click watch-imgStrip.bat.
Leave its black command window running while you add/remove images. It updates imgStrip.js automatically.
You can also open a terminal in the project folder and run: node generateImgStrip.js --watch

ONE-TIME UPDATE
To refresh the list once (for example before uploading the site), run:
    node generateImgStrip.js

Upload imgStrip.js together with the website files after generating it. The strip tiles preserve the full image (no cropping). Clicking a tile opens the original image in a new tab.
