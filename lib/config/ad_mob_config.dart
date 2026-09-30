import 'package:flutter/foundation.dart';

enum AdUnit { newsBanner, newsNative, threadNative }

class AdMobConfig {
  // V1 native factories are Android-only. Other platforms do not request ads.
  static bool get supported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  /// In debug mode, we use placeholders instead of loading real ads.
  static bool get usePlaceholder => kDebugMode;

  static const newsNativeHeight = 144.0;
  // Default fallback height for banner ad until actual adaptive size is loaded.
  static const bannerReservedHeight = 50.0;

  static String unitId(AdUnit unit) =>
      resolveUnitId(unit, release: kReleaseMode);

  static String resolveUnitId(AdUnit unit, {required bool release}) {
    if (!release) {
      return unit == AdUnit.newsBanner
          ? 'ca-app-pub-3940256099942544/6300978111'
          : 'ca-app-pub-3940256099942544/2247696110';
    }
    return switch (unit) {
      AdUnit.newsBanner => const String.fromEnvironment('ADMOB_NEWS_BANNER_ID'),
      AdUnit.newsNative => const String.fromEnvironment('ADMOB_NEWS_NATIVE_ID'),
      AdUnit.threadNative => const String.fromEnvironment(
        'ADMOB_THREAD_NATIVE_ID',
      ),
    };
  }
}
