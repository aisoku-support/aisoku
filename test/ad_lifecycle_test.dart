import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:google_mobile_ads/google_mobile_ads.dart';
import 'package:news_app/config/ad_mob_config.dart';
import 'package:news_app/models/ad_identity.dart';
import 'package:news_app/models/reply_ad_policy.dart';
import 'package:news_app/services/native_ad_slot.dart';
import 'package:news_app/services/thread_ad_session.dart';
import 'package:news_app/widgets/pr_card.dart';

class FakeNativeAd extends NativeAd {
  int loads = 0;
  int disposals = 0;
  FakeNativeAd(NativeAdListener listener)
    : super(
        adUnitId: 'test',
        factoryId: 'test',
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

  void loaded() => listener.onAdLoaded!(this);
  void failed() =>
      listener.onAdFailedToLoad!(this, LoadAdError(3, 'test', 'no fill', null));
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late List<String> events;
  late List<FakeNativeAd> ads;
  late List<NativeAdSlot> slots;
  NativeAdSlot makeSlot(
    AdIdentity identity, {
    AdUnit unit = AdUnit.threadNative,
    Future<bool> Function()? consent,
  }) {
    final slot = NativeAdSlot(
      identity: identity,
      unit: unit,
      consentCheck: consent ?? () async => true,
      eventRecorder: (name, _, _) => events.add(name),
      createAd: (listener, _) {
        final ad = FakeNativeAd(listener);
        ads.add(ad);
        return ad;
      },
    );
    slot.incrementUsage(); // Ensure it doesn't unload automatically in tests
    slots.add(slot);
    return slot;
  }

  AdIdentity identity() =>
      AdIdentity(adFormat: 'native', screen: 'news', placement: 'newsTop');
  setUp(() {
    events = [];
    ads = [];
    slots = [];
  });
  tearDown(() {
    for (final slot in slots) {
      slot.dispose();
    }
  });

  test(
    'consent blocks requests; concurrent load callbacks create only one ad',
    () async {
      bool allowed = false;
      final slot = makeSlot(identity(), consent: () async => allowed);
      slot.incrementUsage();
      await slot.load(320, reason: 'test');
      expect(ads, isEmpty);
      allowed = true;
      await Future.wait([
        slot.load(320, reason: 'test1'),
        slot.load(320, reason: 'test2'),
        slot.load(320, reason: 'test3'),
      ]);
      expect(ads.single.loads, 1);
      ads.single.loaded();
      await slot.load(320, reason: 'test4');
      expect(events.where((e) => e == 'ad_load_requested'), hasLength(1));
    },
  );

  test(
    'dispose while consent check is pending does not create an ad',
    () async {
      final consent = Completer<bool>();
      final slot = makeSlot(identity(), consent: () => consent.future);
      final load = slot.load(320, reason: 'test');
      slot.dispose();
      consent.complete(true);
      await load;
      expect(ads, isEmpty);
    },
  );

  test('news failure preserves height and does not retry', () async {
    final slot = makeSlot(identity(), unit: AdUnit.newsNative);
    final height = slot.height;
    await slot.load(320, reason: 'test');
    ads.single.failed();
    await slot.load(320, reason: 'test');
    expect(slot.state, NativeSlotState.failed);
    expect(slot.height, height);
    expect(ads.single.disposals, 1);
    expect(ads.single.loads, 1);
    slot.dispose();
    expect(ads.single.disposals, 1);
  });

  test('late callbacks after disposal do not load, impress or pay', () async {
    final slot = makeSlot(identity());
    await slot.load(320, reason: 'test');
    slot.dispose();
    ads.single.loaded();
    ads.single.failed();
    ads.single.listener.onAdImpression!(ads.single);
    ads.single.listener.onPaidEvent!(
      ads.single,
      10,
      PrecisionType.precise,
      'JPY',
    );
    expect(events, ['ad_slot_created', 'ad_load_requested']);
    expect(ads.single.disposals, 1);
  });

  test('paid callback is recorded once per physical instance, separate from impression', () async {
    final slot = makeSlot(identity());
    await slot.load(320, reason: 'test');
    ads.single.loaded();
    ads.single.listener.onAdImpression!(ads.single);
    expect(events, isNot(contains('ad_paid')));
    ads.single.listener.onPaidEvent!(
      ads.single,
      12,
      PrecisionType.estimated,
      'USD',
    );
    ads.single.listener.onPaidEvent!(
      ads.single,
      12,
      PrecisionType.estimated,
      'USD',
    );
    expect(events.where((e) => e == 'ad_paid'), hasLength(1));
  });

  test('normal replacement retains opportunity, sequence and shared ID with new physical ad', () async {
    final policy = ReplyAdPolicy();
    final session = ThreadAdSession(
      policy: policy,
      onChanged: () {},
      slotFactory: makeSlot,
    );
    session.addNormalAdAt(9, sharedGenerationId: 'S5');
    session.setWidth(320);
    await Future<void>.delayed(Duration.zero);
    final old = session.slotAt(9)!;
    ads.first.loaded();
    session.handlePostContribution(10, contributionId: 'C12');
    final next = session.slotAt(10)!;
    session.linkLocalGeneration('C12', 'L8');
    await Future<void>.delayed(Duration.zero);
    expect(next.identity.adInstanceId, isNot(old.identity.adInstanceId));
    expect(next.identity.adOpportunityId, old.identity.adOpportunityId);
    expect(next.identity.threadAdSequence, old.identity.threadAdSequence);
    expect(next.identity.replacedNormalAdInstanceId, old.identity.adInstanceId);
    expect(next.identity.sharedGenerationId, 'S5');
    expect(next.identity.localGenerationId, 'L8');
    expect(next.identity.contributionId, 'C12');
    expect(ads.first.disposals, 1);
    expect(ads.last.loads, 1);
    session.handlePostContribution(11, contributionId: 'C13');
    expect(session.slotAt(11), isNull);
    session.dispose();
  });

  test('viewport entry protects normal even without SDK impression and follows shifts', () {
    final policy = ReplyAdPolicy();
    final session = ThreadAdSession(
      policy: policy,
      onChanged: () {},
      slotFactory: makeSlot,
    );
    session.addNormalAdAt(9);
    final old = session.slotAt(9)!;
    session.markEntered(old);
    session.shiftAdsAfter(3, 2);
    session.handlePostContribution(12, contributionId: 'C1');
    expect(session.slotAt(11), same(old));
    expect(session.slotAt(12), isNull);
    expect(policy.placements[11], AdPlacement.normalComment);
    session.dispose();
  });

  test('failed thread slot is removed even after viewport entry; next opportunity works', () async {
    final policy = ReplyAdPolicy();
    int changes = 0;
    final session = ThreadAdSession(
      policy: policy,
      onChanged: () {
        changes++;
      },
      slotFactory: makeSlot,
    );
    session.addNormalAdAt(9);
    final old = session.slotAt(9)!;
    session.markEntered(old);
    await old.load(320, reason: 'test');
    ads.single.failed();
    await Future<void>.delayed(Duration.zero);
    expect(policy.hasAdAt(9), isFalse);
    expect(session.slotAt(9), isNull);
    expect(changes, 1);
    session.addNormalAdAt(19);
    expect(session.slotAt(19)!.identity.threadAdSequence, 2);
    expect(session.slotAt(19)!.identity.sharedGenerationId, isNull);
    session.dispose();
  });

  test('slot unloads when unused and reloads when reused', () async {
    final slot = makeSlot(identity());
    slot.incrementUsage();
    await slot.load(320, reason: 'test');
    ads.single.loaded();
    expect(slot.state, NativeSlotState.loaded);

    slot.unload(reason: 'test');
    expect(slot.state, NativeSlotState.reserved);

    await slot.load(320, reason: 'test');
    ads.last.loaded();
    expect(slot.state, NativeSlotState.loaded);
  });

  test(
    'debug IDs always use Google test units; absent release config is empty',
    () {
      for (final unit in AdUnit.values) {
        expect(
          AdMobConfig.resolveUnitId(unit, release: false),
          startsWith('ca-app-pub-3940256099942544/'),
        );
        expect(AdMobConfig.resolveUnitId(unit, release: true), isEmpty);
      }
      expect(
        AdMobConfig.resolveUnitId(AdUnit.newsNative, release: false),
        AdMobConfig.resolveUnitId(AdUnit.threadNative, release: false),
      );
    },
  );

  test(
    'top ad slot is added, loaded, failed-cleared and disposed properly',
    () async {
      final policy = ReplyAdPolicy();
      int changes = 0;
      final session = ThreadAdSession(
        policy: policy,
        onChanged: () {
          changes++;
        },
        slotFactory: makeSlot,
      );
      session.addTopAd(sharedGenerationId: 'TOP1');
      expect(session.topSlot, isNotNull);
      expect(session.topSlot!.identity.placement, 'normalComment');
      expect(session.topSlot!.identity.sharedGenerationId, 'TOP1');

      await session.topSlot!.load(320, reason: 'test');
      ads.single.failed();
      await Future<void>.delayed(Duration.zero);
      expect(session.topSlot, isNull);
      expect(changes, 1);

      session.addTopAd();
      expect(session.topSlot, isNotNull);
      session.dispose();
      expect(session.topSlot, isNull);
    },
  );
}
