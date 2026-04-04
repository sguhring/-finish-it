1. Project Overview
The application performs three core roles:

Automated Data Entry: Uses Screen Capture and Optical Character Recognition (OCR) to "read" a darts score from a specific region of a user's monitor (likely a digital dartboard or scoring app).

Checkout Logic Engine: A complex mathematical engine that calculates every possible way to finish a game of darts (reaching exactly 0 with a double) based on a detected score (V).

Interactive Web UI: Provides a dashboard that displays "Suggested Ways," "No Score" (Double-Double) paths, and a complete table of outshots for scores between 2 and 170.

2. Technical Stack
Backend: Python 3.x with Flask.

OCR & Image Processing: * pytesseract (Tesseract OCR Engine wrapper).

opencv-python (cv2) for image preprocessing (grayscale, thresholding, resizing).

mss for ultra-fast cross-platform screen grabbing.

Mathematics: numpy for matrix-based combination generation and vectorization.

Concurrency: threading is used to run the OCR capture loop in the background without blocking the web server.

3. Detailed Component Specifications
A. OCR & Capture System (app.py)
Target Region: Configured via OCR_REGION (top:420,left:170,width:350,height:220).

Preprocessing Pipeline:

Capture BGRA → Convert to Grayscale.

Upscale image (2x) to improve Tesseract accuracy.

Apply three thresholding methods: Binary, Binary Inverse, and Otsu.

Artifact Correction: Includes logic to handle common OCR errors (e.g., if it reads "680" instead of "80", it automatically strips the leading digit if it falls within a valid darts score range of 0–501).

B. The Checkout Engine (calculate_output)
The engine generates combinations by categorizing dart throws into specific sets (S1 through S11):

Valid Targets: Singles (1−20,25), Doubles (2−40,50), and Triples (21−60).

Permutations: It uses combvec (a custom Cartesian product function) to create matrices of 3-dart combinations.

Filtering: It filters these matrices for rows where Dart 
1
​
 +Dart 
2
​
 +Dart 
3
​
 =V, ensuring the final dart is always a Double or Bullseye.

C. Logic Filtering (suggested_ways)
Instead of just showing every mathematical possibility, the app applies "pro-style" logic to suggest the best paths:

Preference for "Fat" segments: Prioritizes targets like D20, D16, and D12 which are easier to "split" if missed.

NA-Double-Double: Specifically identifies routes for scores (62–80) that involve skipping the first dart (NA) to leave two doubles.

D. API & Web Routes
/ (Index): Manual input form to check a score.

/api/outshot: JSON endpoint used by the frontend to fetch the latest_score detected by the background OCR thread.

/finishes: A static reference table generated once on startup (_FINISH_TABLE_CACHE) containing all data for scores 2–170.

4. Observations from Debug Images
The uploaded ocr_debug images suggest the system is currently struggling with high-contrast noise:

ocr_debug_binary.png & ocr_debug_binary_inv.png: These show almost entirely empty or blocked-out frames, indicating the fixed threshold of 150 in the code might be too aggressive for the current lighting/UI of the source.

ocr_debug_fixed.png: Shows very thick, "blobby" characters. This suggests that while the OCR can find numbers, the resolution or the thresholding needs further tuning to help Tesseract distinguish between digits like '5' and '6'.

5. Potential Next Steps
Would you like me to refine the OCR thresholding logic in app.py to handle the noise seen in your debug images?

Would you like me to help you build the finishes.html or index.html templates to display this data more cleanly?
