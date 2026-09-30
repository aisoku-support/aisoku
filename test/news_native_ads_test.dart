import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/config/ad_mob_config.dart';
import 'package:news_app/models/ad_identity.dart';
import 'package:news_app/models/news_item.dart';
import 'package:news_app/services/native_ad_slot.dart';
import 'package:news_app/widgets/native_ad_card.dart';
import 'package:news_app/widgets/news_card.dart';
import 'package:news_app/widgets/news_home_home.dart';

import 'ad_lifecycle_test.dart' show FakeNativeAd;

void main() {
  testWidgets(
    '50 news have six logical slots; preload follows viewport; category exit disposes',
    (tester) async {
      final slots = <NativeAdSlot>[];
      final ads = <String, FakeNativeAd>{};
      NativeAdSlot create(AdIdentity identity) {
        final slot = NativeAdSlot(
          identity: identity,
          unit: AdUnit.newsNative,
          consentCheck: () async => true,
          eventRecorder: (_, _, _) {},
          createAd: (listener, _) =>
              ads[identity.adInstanceId] = FakeNativeAd(listener),
        );
        slots.add(slot);
        return slot;
      }

      final news = List.generate(
        50,
        (i) => NewsItem(
          title: 'News $i',
          url: 'https://example.com/$i',
          time: '',
          category: 'source',
          feedUrl: 'https://example.com/feed',
        ),
      );
      Widget page(String category, {int scrollVersion = 0}) => MaterialApp(
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: 360,
              height: 400,
              child: NewsHomeHome(
                isLoading: false,
                errorMessage: null,
                newsList: news,
                savedUrls: const {},
                categoryName: category,
                scrollPositionVersion: scrollVersion,
                onReload: () async {},
                onLoadMore: () {},
                onSave: (_) async {},
                onNewsTap: (_) {},
                onNewsLongPress: (_) {},
                adSlotFactory: create,
              ),
            ),
          ),
        ),
      );
      await tester.pumpWidget(page('A'));
      await tester.pump();
      final top = slots.first;
      expect(top.identity.position, 0);
      expect(ads.length, 1);
      final list = tester.widget<ListView>(find.byType(ListView));
      expect(list.childrenDelegate.estimatedChildCount, 56);
      final firstNewsPosition = tester.getTopLeft(find.byType(NewsCard).first);
      ads[top.identity.adInstanceId]!.failed();
      await tester.pump();
      expect(tester.getTopLeft(find.byType(NewsCard).first), firstNewsPosition);
      expect(
        tester.getSize(find.byType(NativeAdCard).first).height,
        AdMobConfig.newsNativeHeight,
      );

      await tester.drag(find.byType(ListView), const Offset(0, -600));
      await tester.pump();
      expect(slots.any((s) => s.identity.position == 10), isTrue);
      final interval = slots.firstWhere((s) => s.identity.position == 10);
      expect(ads[interval.identity.adInstanceId]!.loads, 1);
      await tester.pumpWidget(page('A', scrollVersion: 1));
      await tester.pump();
      expect(slots.where((s) => s.identity.position == 0), hasLength(1));
      expect(top.state, NativeSlotState.failed);

      await tester.pumpWidget(page('B'));
      await tester.pump();
      expect(top.state, NativeSlotState.disposed);
      expect(interval.state, NativeSlotState.disposed);
      await tester.pumpWidget(page('A'));
      await tester.pump();
      final returned = slots.lastWhere(
        (s) => s.identity.category == 'A' && s.identity.position == 0,
      );
      expect(returned.identity.adInstanceId, isNot(top.identity.adInstanceId));
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      expect(returned.state, NativeSlotState.disposed);
      // unload用10秒Timerを消化してからテストを終了する。
      await tester.pump(const Duration(seconds: 10));
    },
  );
}
