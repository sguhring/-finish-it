import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

void main() {
  runApp(const FinishItApp());
}

class FinishItApp extends StatelessWidget {
  const FinishItApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      home: const PhoneFrame(
        child: FinishItEnhancedPage(),
      ),
    );
  }
}

/// 📱 PHONE FRAME
class PhoneFrame extends StatelessWidget {
  final Widget child;
  const PhoneFrame({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.grey[300],
      body: Center(
        child: Container(
          width: 390,
          height: 844,
          decoration: BoxDecoration(
            color: Colors.black,
            borderRadius: BorderRadius.circular(40),
            boxShadow: const [
              BoxShadow(
                color: Colors.black54,
                blurRadius: 20,
                offset: Offset(0, 8),
              ),
            ],
          ),
          padding: const EdgeInsets.all(10),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(30),
            child: Stack(
              children: [
                Container(color: const Color(0xFFF6F8FA)),
                child,
                Positioned(
                  top: 8,
                  left: 120,
                  right: 120,
                  child: Container(
                    height: 25,
                    decoration: BoxDecoration(
                      color: Colors.black,
                      borderRadius: BorderRadius.circular(20),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 🎯 MAIN PAGE
class FinishItEnhancedPage extends StatefulWidget {
  const FinishItEnhancedPage({super.key});

  @override
  State<FinishItEnhancedPage> createState() => _FinishItEnhancedPageState();
}

class _FinishItEnhancedPageState extends State<FinishItEnhancedPage> {
  final TextEditingController _scoreController =
      TextEditingController(text: '143');

  @override
  Widget build(BuildContext context) {
    const accent = Color(0xFF00A8B5);

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: SafeArea(
        child: Center(
          child: Container(
            width: 360,
            padding: const EdgeInsets.all(20),
            margin: const EdgeInsets.only(top: 10),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(20),
              boxShadow: const [
                BoxShadow(
                  color: Colors.black12,
                  blurRadius: 12,
                  offset: Offset(0, 4),
                ),
              ],
            ),

            // MAIN CONTENT
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // TITLE + ICON
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          "Finish IT",
                          style: GoogleFonts.roboto(
                            fontSize: 24,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        Text(
                          "Dart Outshot Calculator",
                          style: GoogleFonts.roboto(
                            fontSize: 14,
                            color: Colors.black54,
                          ),
                        ),
                      ],
                    ),

                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: accent.withOpacity(0.15),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Icon(
                        Icons.edit,
                        color: Color(0xFF007E87),
                        size: 20,
                      ),
                    )
                  ],
                ),

                const SizedBox(height: 20),

                // ENTER SCORE
                Text(
                  "Enter Score:",
                  style: GoogleFonts.roboto(
                    fontSize: 15,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                const SizedBox(height: 6),

                Row(
                  children: [
                    SizedBox(
                      width: 80,
                      height: 44,
                      child: TextField(
                        controller: _scoreController,
                        textAlign: TextAlign.center,
                        keyboardType: TextInputType.number,
                        decoration: InputDecoration(
                          filled: true,
                          fillColor: Colors.grey[50],
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(10),
                            borderSide: const BorderSide(color: Colors.black26),
                          ),
                        ),
                        style: const TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),

                    const SizedBox(width: 12),

                    ElevatedButton(
                      onPressed: () {},
                      style: ElevatedButton.styleFrom(
                        backgroundColor: accent,
                        padding: const EdgeInsets.symmetric(
                          horizontal: 20,
                          vertical: 12,
                        ),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                      child: const Text(
                        "Calculate",
                        style: TextStyle(fontSize: 15, color: Colors.white),
                      ),
                    ),
                  ],
                ),

                const SizedBox(height: 22),

                // BEST FINISH
                Row(
                  children: [
                    Icon(Icons.arrow_forward, color: accent, size: 20),
                    const SizedBox(width: 6),
                    Text(
                      "Best Finish:",
                      style: GoogleFonts.roboto(
                        fontSize: 16,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                ),

                const SizedBox(height: 10),

                Text(
                  "➡  T19 → T18 → D16",
                  style: GoogleFonts.roboto(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                    color: accent,
                  ),
                ),

                const SizedBox(height: 26),

                // ALTERNATIVES
                Text(
                  "Alternatives",
                  style: GoogleFonts.roboto(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                  ),
                ),

                const SizedBox(height: 12),

                Wrap(
                  spacing: 10,
                  runSpacing: 12,
                  children: const [
                    AltBox("T20 → T17 → D16"),
                    AltBox("T20 → T19 → D13"),
                    AltBox("T18 → T17 → D19"),
                    AltBox("T20 → T15 → D19"),
                    AltBox("T17 → T18 → D18"),
                    AltBox("T19 → T16 → D18"),
                    AltBox("T18 → T19 → D14"),
                    AltBox("T17 → T19 → D16"),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Pill-style alternative box
class AltBox extends StatelessWidget {
  final String text;
  const AltBox(this.text, {super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: Colors.grey[50],
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Colors.black12),
      ),
      child: Text(
        text,
        style: const TextStyle(
          fontSize: 14,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}
