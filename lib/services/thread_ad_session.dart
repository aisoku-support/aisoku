import 'dart:async';

import '../config/ad_mob_config.dart';
import '../models/ad_identity.dart';
import '../models/reply_ad_policy.dart';
import '../widgets/pr_card.dart';
import 'native_ad_slot.dart';

class ThreadAdSession {
  final ReplyAdPolicy policy;
  final void Function() onChanged;
  final String sessionId = newMeasurementId();
  final Map<int, NativeAdSlot> _slots = {};
  NativeAdSlot? _topSlot;
  final NativeAdSlot Function(AdIdentity)? slotFactory;
  int _sequence = 0;
  bool _disposed = false;
  double? _width;
  ThreadAdSession({
    required this.policy,
    required this.onChanged,
    this.slotFactory,
  });

  NativeAdSlot? slotAt(int index) => _slots[index];
  NativeAdSlot? get topSlot => _topSlot;

  void setWidth(double width) {
    _width = width;
    if (_topSlot != null) {
      unawaited(_topSlot!.load(width, reason: 'threadWidth'));
    }
    for (final slot in _slots.values) {
      unawaited(slot.load(width, reason: 'threadWidth'));
    }
  }

  void addTopAd({String? sharedGenerationId}) {
    if (_disposed || _topSlot != null) return;
    final identity = AdIdentity(
      adFormat: 'native',
      screen: 'thread',
      placement: 'normalComment',
      adOpportunityId: newMeasurementId(),
      threadAdSequence: ++_sequence,
      threadSessionId: sessionId,
      sharedGenerationId: sharedGenerationId,
    );
    final slot =
        slotFactory?.call(identity) ??
        NativeAdSlot(identity: identity, unit: AdUnit.threadNative);
    _topSlot = slot;
    slot.addListener(() {
      if (slot.state != NativeSlotState.failed) return;
      scheduleMicrotask(() {
        if (_disposed) return;
        if (identical(_topSlot, slot)) {
          _topSlot = null;
          slot.dispose();
          onChanged();
        }
      });
    });
    if (_width != null) unawaited(slot.load(_width!, reason: 'threadTopAdd'));
  }

  void addNormalAdAt(int index, {String? sharedGenerationId}) {
    if (_disposed || policy.hasAdAt(index)) return;
    policy.addNormalAdAt(index);
    _add(
      index,
      AdIdentity(
        adFormat: 'native',
        screen: 'thread',
        placement: 'normalComment',
        adOpportunityId: newMeasurementId(),
        threadAdSequence: ++_sequence,
        threadSessionId: sessionId,
        sharedGenerationId: sharedGenerationId,
      ),
    );
  }

  void handlePostContribution(int index, {required String contributionId}) {
    final previous = _slots[index - 1];
    policy.handlePostContribution(index);
    if (policy.placements[index] != AdPlacement.postContribution ||
        _slots.containsKey(index)) {
      return;
    }
    final replaced = previous != null && !policy.hasAdAt(index - 1)
        ? previous
        : null;
    if (replaced != null) {
      _slots.remove(index - 1);
      replaced.dispose();
    }
    _add(
      index,
      AdIdentity(
        adFormat: 'native',
        screen: 'thread',
        placement: 'postContribution',
        adOpportunityId:
            replaced?.identity.adOpportunityId ?? newMeasurementId(),
        threadAdSequence: replaced?.identity.threadAdSequence ?? ++_sequence,
        threadSessionId: sessionId,
        replacedNormalAdInstanceId: replaced?.identity.adInstanceId,
        sharedGenerationId: replaced?.identity.sharedGenerationId,
        contributionId: contributionId,
      ),
    );
  }

  void _add(int index, AdIdentity identity) {
    final slot =
        slotFactory?.call(identity) ??
        NativeAdSlot(identity: identity, unit: AdUnit.threadNative);
    _slots[index] = slot;
    slot.addListener(() {
      if (slot.state != NativeSlotState.failed) return;
      scheduleMicrotask(() {
        if (_disposed) return;
        final keys = _slots.entries
            .where((entry) => identical(entry.value, slot))
            .map((e) => e.key)
            .toList();
        for (final key in keys) {
          _slots.remove(key);
          policy.removeAdAt(key);
        }
        slot.dispose();
        onChanged();
      });
    });
    if (_width != null) unawaited(slot.load(_width!, reason: 'threadAdd'));
  }

  void markEntered(NativeAdSlot slot) {
    for (final entry in _slots.entries) {
      if (identical(entry.value, slot)) policy.markEnteredViewport(entry.key);
    }
  }

  void linkLocalGeneration(String contributionId, String generationId) {
    for (final slot in _slots.values) {
      if (slot.identity.contributionId == contributionId) {
        slot.linkLocalGeneration(generationId);
      }
    }
  }

  void shiftAdsAfter(int index, int count) {
    policy.shiftAdsAfter(index, count);
    final shifted = {
      for (final e in _slots.entries)
        (e.key > index ? e.key + count : e.key): e.value,
    };
    _slots
      ..clear()
      ..addAll(shifted);
  }

  void dispose() {
    _disposed = true;
    _topSlot?.dispose();
    _topSlot = null;
    for (final slot in _slots.values) {
      slot.dispose();
    }
    _slots.clear();
    policy.clear();
  }
}
