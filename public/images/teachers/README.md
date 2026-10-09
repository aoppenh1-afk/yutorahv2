# Player portraits

`aryeh-lebowitz.jpg` is the unmodified 5602 × 3735 original photograph published by Yeshiva University, used for YUTorah teacher ID 80714.

- Article: https://www.yu.edu/news/yu/new-leadership-yu-riets-start-fall-semester
- Original: https://www.yu.edu/sites/default/files/20191002-faculty-staff-aryeh-lebowitz-2.jpg

The expanded player selects a display-sized local derivative instead of stretching the 50px teacher thumbnail. Other teachers use YUTorah's larger `_lp` portrait when available, with the original API image as a fallback. Image resolution never changes the player's portrait frame size.

## Player derivatives

The 320, 640, and 960 pixel JPGs are display-sized derivatives of the verified
`aryeh-lebowitz.jpg` photograph documented above. Generate them with FFmpeg
`-vf scale=WIDTH:-2 -q:v 3`; the original remains the provenance source.
