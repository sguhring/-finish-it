import cv2
import pytesseract
import numpy as np
import re
import sys

# Set Tesseract path
pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'

def ocr_image_file(filename):
    """Run OCR on a saved image file."""
    try:
        # Read the image
        img = cv2.imread(filename)
        if img is None:
            print(f"❌ Error: Could not read image file '{filename}'")
            print(f"   Make sure the file exists in the current directory.")
            return None
        
        print(f"✅ Image loaded: {filename}")
        print(f"   Image size: {img.shape[1]}x{img.shape[0]} pixels")
        
        # Convert to grayscale
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        
        # Simpler preprocessing - less aggressive to avoid artifacts
        gray = cv2.resize(gray, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
        
        # Simple threshold works better for clean, high-contrast digits
        _, th = cv2.threshold(gray, 127, 255, cv2.THRESH_BINARY)
        
        # Light denoising only
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
        th = cv2.morphologyEx(th, cv2.MORPH_OPEN, kernel)
        
        # Alternative: Adaptive threshold for comparison
        th_adaptive = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, 
                                            cv2.THRESH_BINARY, 11, 2)
        
        # Alternative: OTSU threshold
        _, th_otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        
        # Try inverting (white text on black background)
        th_inv = cv2.bitwise_not(th)
        
        # Try inverting (white text on black background)
        th_inv = cv2.bitwise_not(th)
        
        # Save all versions for comparison
        processed_filename = filename.replace('.png', '_processed.png')
        cv2.imwrite(processed_filename.replace('.png', '_simple.png'), th)
        cv2.imwrite(processed_filename.replace('.png', '_adaptive.png'), th_adaptive)
        cv2.imwrite(processed_filename.replace('.png', '_otsu.png'), th_otsu)
        cv2.imwrite(processed_filename.replace('.png', '_inverted.png'), th_inv)
        print(f"✅ Processed images saved with different methods")
        
        # Try OCR with multiple methods and PSM modes
        results = []
        
        # Method 1: Simple threshold with PSM 8 (single word - BEST for digits)
        text1 = pytesseract.image_to_string(th, config="--psm 8 -c tessedit_char_whitelist=0123456789 --oem 3")
        results.append(("Simple threshold PSM 8", text1))
        
        # Method 2: OTSU with PSM 7
        text2 = pytesseract.image_to_string(th_otsu, config="--psm 7 -c tessedit_char_whitelist=0123456789 --oem 3")
        results.append(("OTSU PSM 7", text2))
        
        # Method 3: Inverted with PSM 7
        text3 = pytesseract.image_to_string(th_inv, config="--psm 7 -c tessedit_char_whitelist=0123456789 --oem 3")
        results.append(("Inverted PSM 7", text3))
        
        # Method 4: Simple with PSM 8 (single word)
        text4 = pytesseract.image_to_string(th, config="--psm 8 -c tessedit_char_whitelist=0123456789 --oem 3")
        results.append(("Simple threshold PSM 8", text4))
        
        # Method 5: Simple with PSM 13 (raw line)
        text5 = pytesseract.image_to_string(th, config="--psm 13 -c tessedit_char_whitelist=0123456789 --oem 3")
        results.append(("Simple threshold PSM 13", text5))
        
        # Method 6: Inverted with PSM 8
        text6 = pytesseract.image_to_string(th_inv, config="--psm 8 -c tessedit_char_whitelist=0123456789 --oem 3")
        results.append(("Inverted PSM 8", text6))
        
        print(f"\n📊 Testing multiple OCR methods:\n")
        best_result = None
        best_score = None
        
        for method, text in results:
            numbers = re.findall(r"\d+", text)
            if numbers:
                # Filter valid dart scores
                valid_scores = [int(n) for n in numbers if 0 <= int(n) <= 501]
                
                if valid_scores:
                    score = valid_scores[0]
                    
                    # Check for false leading digits (e.g., 664 -> 64)
                    if score >= 600:
                        score_str = str(score)
                        if len(score_str) >= 3:
                            alternative = int(score_str[1:])
                            if 0 <= alternative <= 501:
                                print(f"  {method:25s} → '{text.strip():10s}' → {score} → CORRECTED to {alternative}")
                                score = alternative
                            else:
                                print(f"  {method:25s} → '{text.strip():10s}' → Score: {score} (INVALID)")
                    else:
                        print(f"  {method:25s} → '{text.strip():10s}' → Score: {score}")
                    
                    if best_result is None:
                        best_result = text
                        best_score = score
                else:
                    print(f"  {method:25s} → '{text.strip():10s}' → {numbers} (out of range)")
            else:
                print(f"  {method:25s} → '{text.strip():10s}' → No number found")
        
        # Use the first successful result
        text = best_result if best_result else text1
        
        print(f"\n📄 Selected OCR Text: '{text.strip()}'")
        
        # Extract first number found
        m = re.search(r"\d+", text)
        if m:
            score = int(m.group(0))
            
            # Apply same correction as in app.py
            if score >= 600:
                score_str = str(score)
                if len(score_str) >= 3:
                    alternative = int(score_str[1:])
                    if 0 <= alternative <= 501:
                        print(f"🔧 Corrected {score} to {alternative}")
                        score = alternative
            
            print(f"🎯 Extracted Score: {score}")
            return score
        else:
            print("⚠️  No number found in OCR result")
            return None
            
    except Exception as e:
        print(f"❌ Error: {e}")
        return None

if __name__ == "__main__":
    filename = sys.argv[1] if len(sys.argv) > 1 else "test.png"
    print(f"\n🔍 Running OCR on: {filename}\n")
    ocr_image_file(filename)
