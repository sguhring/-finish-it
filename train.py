"""
train.py
========
Trains a small CNN to classify darts scores (0-501) from grayscale images.

Usage:
    python train.py

Reads images from training_data/ (created by generate_data.py).
Saves the trained model to darts_ocr.pth.

Requirements:
    pip install torch torchvision pillow
"""

import os
import glob

print("Loading PyTorch (first import can take 10-30 s — please wait)...", flush=True)
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader
from torchvision import transforms
from PIL import Image
print("PyTorch loaded.", flush=True)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
DATA_DIR    = "training_data"
MODEL_PATH  = "darts_ocr.pth"
IMG_W       = 160
IMG_H       = 64
BATCH_SIZE  = 32
EPOCHS      = 10
LR          = 1e-3
VAL_SPLIT   = 0.1
MAX_SAMPLES = None   # cap dataset size for faster training (None = use all)
DEVICE      = "cuda" if torch.cuda.is_available() else "cpu"

# ---------------------------------------------------------------------------
# Dataset
# ---------------------------------------------------------------------------

class DartsDataset(Dataset):
    def __init__(self, samples: list, transform):
        self.samples   = samples   # list of (path, label) tuples
        self.transform = transform

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        path, label = self.samples[idx]
        img = Image.open(path).convert("L")
        return self.transform(img), label


def load_samples(data_dir: str) -> list:
    samples = []
    for path in glob.glob(os.path.join(data_dir, "*.png")):
        fname = os.path.splitext(os.path.basename(path))[0]
        # Filenames: "471" (base) or "aug_471_3" (augmented)
        if fname.startswith("aug_"):
            parts = fname.split("_")
            label = int(parts[1])
        else:
            label = int(fname)
        samples.append((path, label))
    return samples


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------

class ScoreCNN(nn.Module):
    """
    Lightweight CNN for classifying 160x64 greyscale score images into
    502 classes (scores 0-501).

    Architecture:
        3 conv blocks (conv -> relu -> maxpool)  →  flatten  →  2 FC layers
    Input:  [B, 1, 64, 160]
    Output: [B, 502]
    """
    def __init__(self):
        super().__init__()
        self.features = nn.Sequential(
            # Block 1: [1,64,160] -> [32,32,80]
            nn.Conv2d(1, 32, kernel_size=3, padding=1),
            nn.BatchNorm2d(32),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),
            # Block 2: [32,32,80] -> [64,16,40]
            nn.Conv2d(32, 64, kernel_size=3, padding=1),
            nn.BatchNorm2d(64),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),
            # Block 3: [64,16,40] -> [128,8,20]
            nn.Conv2d(64, 128, kernel_size=3, padding=1),
            nn.BatchNorm2d(128),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),
        )
        # 128 * 8 * 20 = 20480
        self.classifier = nn.Sequential(
            nn.Flatten(),
            nn.Linear(128 * 8 * 20, 128),
            nn.ReLU(inplace=True),
            nn.Dropout(0.4),
            nn.Linear(128, 502),
        )

    def forward(self, x):
        return self.classifier(self.features(x))


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

def train():
    print(f"Device: {DEVICE}")

    samples = load_samples(DATA_DIR)
    if not samples:
        print(f"ERROR: No images found in '{DATA_DIR}/'")
        print("       Run  python generate_data.py  first.")
        return

    print(f"Dataset: {len(samples)} images across 502 classes")

    # Shuffle and optionally cap
    import random
    random.seed(42)
    random.shuffle(samples)
    if MAX_SAMPLES and len(samples) > MAX_SAMPLES:
        samples = samples[:MAX_SAMPLES]
        print(f"Capped to {MAX_SAMPLES} samples")
    val_n      = int(len(samples) * VAL_SPLIT)
    val_samp   = samples[:val_n]
    train_samp = samples[val_n:]

    transform = transforms.Compose([
        transforms.Resize((IMG_H, IMG_W)),
        transforms.ToTensor(),
        transforms.Normalize([0.5], [0.5]),
    ])

    train_ds = DartsDataset(train_samp, transform)
    val_ds   = DartsDataset(val_samp,   transform)

    train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True,  num_workers=0)
    val_loader   = DataLoader(val_ds,   batch_size=BATCH_SIZE, shuffle=False, num_workers=0)

    model     = ScoreCNN().to(DEVICE)
    optimizer = torch.optim.Adam(model.parameters(), lr=LR)
    scheduler = torch.optim.lr_scheduler.StepLR(optimizer, step_size=10, gamma=0.3)
    criterion = nn.CrossEntropyLoss()

    best_acc = 0.0

    for epoch in range(1, EPOCHS + 1):
        # --- Train ---
        model.train()
        train_loss = 0.0
        for imgs, labels in train_loader:
            imgs, labels = imgs.to(DEVICE), labels.to(DEVICE)
            optimizer.zero_grad()
            loss = criterion(model(imgs), labels)
            loss.backward()
            optimizer.step()
            train_loss += loss.item() * len(imgs)
        scheduler.step()

        # --- Validate ---
        model.eval()
        correct = total = 0
        with torch.no_grad():
            for imgs, labels in val_loader:
                imgs, labels = imgs.to(DEVICE), labels.to(DEVICE)
                preds    = model(imgs).argmax(1)
                correct += (preds == labels).sum().item()
                total   += len(labels)

        acc = correct / total if total else 0.0
        avg_loss = train_loss / len(train_samp)
        print(f"Epoch {epoch:>2}/{EPOCHS}  loss={avg_loss:.4f}  val_acc={acc:.4f}")

        if acc > best_acc:
            best_acc = acc
            torch.save(model.state_dict(), MODEL_PATH)
            print(f"           >> Saved best model (acc={best_acc:.4f})")

    print(f"\nTraining complete. Best val accuracy: {best_acc:.4f}")
    print(f"Model saved to: {MODEL_PATH}")
    print(f"\nNext step: restart app.py — it will use the CNN automatically.")


if __name__ == "__main__":
    train()
