import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_mobile_ads/google_mobile_ads.dart';
import 'package:news_app/config/ad_mob_config.dart';
import 'package:news_app/widgets/news_banner_ad.dart';

class FakeBanner extends BannerAd {
  int loads = 0;
  int disposals = 0;
  FakeBanner(AdSize size, BannerAdListener listener)
    : super(
        adUnitId: 'test',
        size: size,
        listener: listener,
        request: const AdRequest(),
      );
  @override
  Future<void> load() async {
    loads++;
  }

  @override
  Future<void> dispose() async {
    disposals++;
  }
}

void main() {
  testWidgets(
    'banner reserves height before consent/size lookup and never retries after failure',
    (tester) async {
      final ads = <FakeBanner>[];
      bool allowed = false;
      Widget page(int rebuild) => MaterialApp(
        home: Scaffold(
          body: Column(
            children: [
              Text('$rebuild'),
              NewsBannerAd(
                consentCheck: () async => allowed,
                sizeLoader: (_) async => const AdSize(width: 320, height: 100),
                adFactory: (size, listener) {
                  final ad = FakeBanner(size, listener);
                  ads.add(ad);
                  return ad;
                },
              ),
            ],
          ),
        ),
      );
      await tester.pumpWidget(page(0));
      await tester.pump();
      expect(ads, isEmpty);
      final reserved = tester.getSize(find.byType(NewsBannerAd)).height;
      expect(reserved, AdMobConfig.bannerReservedHeight);
      allowed = true;
      await tester.pumpWidget(page(1));
      await tester.pump();
      expect(ads.single.loads, 1);
      ads.single.listener.onAdFailedToLoad!(
        ads.single,
        LoadAdError(3, 'test', 'no fill', null),
      );
      await tester.pumpWidget(page(2));
      await tester.pump();
      // 失敗後も取得済みAdaptive Size（100.0）を予約高さとして維持する（CURRENT_SPEC 18.2）。
      expect(tester.getSize(find.byType(NewsBannerAd)).height, 100.0);
      expect(ads.single.loads, 1);
      expect(ads.single.disposals, 1);
      await tester.pumpWidget(const SizedBox.shrink());
      expect(ads.single.disposals, 1);
    },
  );
}
