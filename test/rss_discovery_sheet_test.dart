import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/models/rss_discovery_candidate.dart';
import 'package:news_app/models/rss_feed.dart';
import 'package:news_app/services/rss_discovery_service.dart';
import 'package:news_app/widgets/rss_discovery_sheet.dart';

class FakeDiscoveryService extends RssDiscoveryService {
  FakeDiscoveryService(this.result);
  final Future<List<RssDiscoveryCandidate>> result;
  @override
  Future<List<RssDiscoveryCandidate>> discover({
    required String articleUrl,
    String? sourceName,
  }) => result;
}

Widget sheet({
  required RssDiscoveryService service,
  required bool Function(String) registered,
  required Future<void> Function(RssFeed) add,
}) => MaterialApp(
  home: Scaffold(
    body: RssDiscoverySheet(
      articleUrl: 'https://example.com/article',
      sourceName: 'Example',
      discoveryService: service,
      isRegistered: registered,
      addFeed: add,
      onRegistered: () {},
    ),
  ),
);

void main() {
  testWidgets('one available candidate is immediately registered', (
    tester,
  ) async {
    RssFeed? added;
    await tester.pumpWidget(
      sheet(
        service: FakeDiscoveryService(
          Future.value([
            const RssDiscoveryCandidate(
              url: 'https://example.com/feed',
              title: 'Feed',
              isRegistered: false,
            ),
          ]),
        ),
        registered: (_) => false,
        add: (feed) async => added = feed,
      ),
    );
    await tester.pumpAndSettle();
    expect(added?.url, 'https://example.com/feed');
  });

  testWidgets('multiple candidates require one enabled selection', (
    tester,
  ) async {
    final added = <RssFeed>[];
    await tester.pumpWidget(
      sheet(
        service: FakeDiscoveryService(
          Future.value([
            const RssDiscoveryCandidate(
              url: 'https://example.com/a',
              title: 'A',
              isRegistered: false,
            ),
            const RssDiscoveryCandidate(
              url: 'https://example.com/b',
              title: 'B',
              isRegistered: false,
            ),
          ]),
        ),
        registered: (url) => url.endsWith('/b'),
        add: (feed) async => added.add(feed),
      ),
    );
    await tester.pumpAndSettle();
    expect(added, isEmpty);
    expect(find.text('登録済み'), findsOneWidget);
    await tester.tap(find.text('A'));
    await tester.pumpAndSettle();
    expect(added.single.url, 'https://example.com/a');
  });

  testWidgets(
    'registered candidates are disabled and all registered message is shown',
    (tester) async {
      await tester.pumpWidget(
        sheet(
          service: FakeDiscoveryService(
            Future.value([
              const RssDiscoveryCandidate(
                url: 'https://example.com/feed',
                title: 'Feed',
                isRegistered: false,
              ),
            ]),
          ),
          registered: (_) => true,
          add: (_) async {},
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('このサイトのRSSは登録済みです'), findsOneWidget);
    },
  );

  testWidgets('discovery failure uses the unified message', (tester) async {
    final completer = Completer<List<RssDiscoveryCandidate>>();
    await tester.pumpWidget(
      sheet(
        service: FakeDiscoveryService(completer.future),
        registered: (_) => false,
        add: (_) async {},
      ),
    );
    completer.completeError(Exception('network'));
    await tester.pumpAndSettle();
    expect(find.text('RSSを登録できませんでした'), findsOneWidget);
  });

  testWidgets('discovery failure is dismissed after three seconds', (
    tester,
  ) async {
    final completer = Completer<List<RssDiscoveryCandidate>>();
    await tester.pumpWidget(
      sheet(
        service: FakeDiscoveryService(completer.future),
        registered: (_) => false,
        add: (_) async {},
      ),
    );
    completer.completeError(Exception('network'));
    await tester.pumpAndSettle();
    expect(find.text('RSSを登録できませんでした'), findsOneWidget);
    await tester.pump(const Duration(seconds: 3));
    expect(find.text('RSSを登録できませんでした'), findsNothing);
  });

  testWidgets('closing before the failure timeout does not throw', (
    tester,
  ) async {
    final completer = Completer<List<RssDiscoveryCandidate>>();
    await tester.pumpWidget(
      sheet(
        service: FakeDiscoveryService(completer.future),
        registered: (_) => false,
        add: (_) async {},
      ),
    );
    completer.completeError(Exception('network'));
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 3));
    expect(tester.takeException(), isNull);
  });

  testWidgets('registered message is not dismissed after three seconds', (
    tester,
  ) async {
    await tester.pumpWidget(
      sheet(
        service: FakeDiscoveryService(
          Future.value([
            const RssDiscoveryCandidate(
              url: 'https://example.com/feed',
              title: 'Feed',
              isRegistered: false,
            ),
          ]),
        ),
        registered: (_) => true,
        add: (_) async {},
      ),
    );
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 3));
    expect(find.text('このサイトのRSSは登録済みです'), findsOneWidget);
  });

  testWidgets('disposing before discovery completes does not register', (
    tester,
  ) async {
    final completer = Completer<List<RssDiscoveryCandidate>>();
    var added = false;
    await tester.pumpWidget(
      sheet(
        service: FakeDiscoveryService(completer.future),
        registered: (_) => false,
        add: (_) async => added = true,
      ),
    );
    await tester.pumpWidget(const SizedBox());
    completer.complete([
      const RssDiscoveryCandidate(
        url: 'https://example.com/feed',
        title: 'Feed',
        isRegistered: false,
      ),
    ]);
    await tester.pumpAndSettle();
    expect(added, isFalse);
  });

  testWidgets('registration completes after the sheet is disposed', (
    tester,
  ) async {
    final completer = Completer<void>();
    var registered = false;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: RssDiscoverySheet(
            articleUrl: 'https://example.com/article',
            sourceName: 'Example',
            discoveryService: FakeDiscoveryService(
              Future.value([
                const RssDiscoveryCandidate(
                  url: 'https://example.com/feed',
                  title: 'Feed',
                  isRegistered: false,
                ),
              ]),
            ),
            isRegistered: (_) => false,
            addFeed: (_) => completer.future,
            onRegistered: () => registered = true,
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
    completer.complete();
    await tester.pumpAndSettle();
    expect(registered, isTrue);
  });
}
