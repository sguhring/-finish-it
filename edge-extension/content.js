// Inject OCR-A font and apply it to score number elements
(function () {
  const style = document.createElement("style");
  style.textContent = `
    @import url('https://fonts.cdnfonts.com/css/ocr-a-extended');

    /* ── Finish IT (127.0.0.1:5000) ── */
    .score-display,
    .header-score,
    .finish-row .dart,
    .finish-row .dart-double,
    #liveScore,
    .field-btn .field-num {
      font-family: 'OCR A Extended', 'OCR A Std', monospace !important;
      letter-spacing: 0.05em !important;
    }

    /* ── Scolia (game.scoliadarts.com) ── */
    * {
      font-family: 'OCR A Extended', 'OCR A Std', monospace !important;
    }
  `;
  document.head.appendChild(style);
})();
