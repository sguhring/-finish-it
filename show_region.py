import mss
import cv2
import numpy as np

# Same region as in app.py
OCR_REGION = {"top": 420, "left": 200, "width": 350, "height": 220}
def show_ocr_region():
    """Display the OCR region on screen."""
    try:
        with mss.mss() as sct:
            img = np.array(sct.grab(OCR_REGION))  # BGRA

        # Convert BGRA to BGR for OpenCV
        img_bgr = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
        
        # Save screenshot of the region
        cv2.imwrite("ocr_region_current.png", img_bgr)
        print(f"✅ OCR region screenshot saved to: ocr_region_current.png")
        print(f"Region: top={OCR_REGION['top']}, left={OCR_REGION['left']}, width={OCR_REGION['width']}, height={OCR_REGION['height']}")
        
        # Display it
        cv2.imshow("Current OCR Region (close window to continue)", img_bgr)
        cv2.waitKey(0)
        cv2.destroyAllWindows()
    except Exception as e:
        print(f"❌ Error: {e}")

if __name__ == "__main__":
    show_ocr_region()
