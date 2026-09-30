import 'package:flutter/foundation.dart';

class NewsPerf {
  static final Stopwatch _stopwatch = Stopwatch();
  static int _lastMark = 0;

  static void start() {
    _stopwatch.reset();
    _stopwatch.start();
    _lastMark = 0;
    debugPrint('[NewsPerf] START +0ms');
  }

  static void mark(String label, {String? extra}) {
    if (!_stopwatch.isRunning) return;
    final now = _stopwatch.elapsedMilliseconds;
    final delta = now - _lastMark;
    _lastMark = now;

    String message = '[NewsPerf] $label +${now}ms delta=${delta}ms';
    if (extra != null) {
      message += ' $extra';
    }
    debugPrint(message);
  }

  static void stop() {
    _stopwatch.stop();
  }
}
