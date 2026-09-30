import 'package:flutter/foundation.dart';

/// アプリ起動パフォーマンスを計測するためのユーティリティクラス
class StartupPerf {
  static final Stopwatch _stopwatch = Stopwatch();
  static int _lastLapTime = 0;
  static bool _isCompleted = false;

  /// 計測を開始する
  static void start() {
    // DebugモードだけでなくProfileモードでも計測・出力できるように変更
    if (kDebugMode || kProfileMode) {
      _stopwatch.start();
      debugPrint('[StartupPerf] START');
    }
  }

  /// ラップタイムを記録しログを出力する
  static void mark(String label, {String? extra}) {
    if ((!kDebugMode && !kProfileMode) || _isCompleted) return;

    final int total = _stopwatch.elapsedMilliseconds;
    final int delta = total - _lastLapTime;
    _lastLapTime = total;

    String log = '[StartupPerf] $label | delta=${delta}ms | total=${total}ms';
    if (extra != null) {
      log += ' | $extra';
    }
    debugPrint(log);
  }

  /// 計測を完了する
  static void complete() {
    if ((!kDebugMode && !kProfileMode) || _isCompleted) return;
    _isCompleted = true;
    _stopwatch.stop();
    debugPrint(
      '[StartupPerf] COMPLETE total=${_stopwatch.elapsedMilliseconds}ms',
    );
  }
}
