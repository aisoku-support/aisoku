import 'dart:math';

import 'reply_item.dart';

enum ConversationPattern {
  independent,
  singleReply,
  doubleReply,
  chain3,
  branch,
  mixed;

  static ConversationPattern? fromStorage(String? value) {
    for (final pattern in values) {
      if (pattern.name == value) return pattern;
    }
    return null;
  }
}

class ReplyRelation {
  final int from;
  final int to;

  const ReplyRelation({required this.from, required this.to});
}

class ConversationPlan {
  final ConversationPattern pattern;
  final List<ReplyRelation> relations;

  const ConversationPlan({required this.pattern, required this.relations});

  double densityFor(int count) {
    if (count <= 0) return 0;
    final participants = <int>{};
    for (final relation in relations) {
      participants
        ..add(relation.from)
        ..add(relation.to);
    }
    return participants.length / count;
  }

  bool isValidFor(int count) {
    return relations.every(
      (relation) =>
          relation.from >= 1 &&
          relation.from <= count &&
          relation.to >= 1 &&
          relation.to <= count &&
          relation.from != relation.to,
    );
  }

  static ConversationPlan generate({required int count, Random? random}) {
    final rng = random ?? Random();
    final roll = rng.nextInt(100);
    final selected = switch (roll) {
      < 10 => ConversationPattern.independent,
      < 30 => ConversationPattern.singleReply,
      < 55 => ConversationPattern.doubleReply,
      < 75 => ConversationPattern.chain3,
      < 90 => ConversationPattern.branch,
      _ => ConversationPattern.mixed,
    };
    return _generatePattern(selected, count, rng);
  }

  static ConversationPlan forPattern({
    required ConversationPattern pattern,
    required int count,
    Random? random,
  }) {
    return _generatePattern(pattern, count, random ?? Random());
  }

  static ConversationPlan _generatePattern(
    ConversationPattern pattern,
    int count,
    Random random,
  ) {
    if (count < 2) {
      return const ConversationPlan(
        pattern: ConversationPattern.independent,
        relations: [],
      );
    }

    switch (pattern) {
      case ConversationPattern.independent:
        return const ConversationPlan(
          pattern: ConversationPattern.independent,
          relations: [],
        );
      case ConversationPattern.singleReply:
        final start = _randomContiguousStart(count, 2, random);
        return ConversationPlan(
          pattern: pattern,
          relations: [ReplyRelation(from: start + 1, to: start)],
        );
      case ConversationPattern.doubleReply:
        if (count < 4) {
          return _generatePattern(
            ConversationPattern.singleReply,
            count,
            random,
          );
        }
        final starts = List<int>.generate(count - 1, (index) => index + 1)
          ..shuffle(random);
        final firstStart = starts.first;
        final secondStart = starts.firstWhere(
          (start) => (start - firstStart).abs() >= 2,
        );
        return ConversationPlan(
          pattern: pattern,
          relations: [
            ReplyRelation(from: firstStart + 1, to: firstStart),
            ReplyRelation(from: secondStart + 1, to: secondStart),
          ],
        );
      case ConversationPattern.chain3:
        if (count < 3) {
          return _generatePattern(
            ConversationPattern.singleReply,
            count,
            random,
          );
        }
        final start = _randomContiguousStart(count, 3, random);
        return ConversationPlan(
          pattern: pattern,
          relations: [
            ReplyRelation(from: start + 1, to: start),
            ReplyRelation(from: start + 2, to: start + 1),
          ],
        );
      case ConversationPattern.branch:
        if (count < 3) {
          return _generatePattern(
            ConversationPattern.singleReply,
            count,
            random,
          );
        }
        final start = _randomContiguousStart(count, 3, random);
        return ConversationPlan(
          pattern: pattern,
          relations: [
            ReplyRelation(from: start + 1, to: start),
            ReplyRelation(from: start + 2, to: start),
          ],
        );
      case ConversationPattern.mixed:
        if (count < 5) {
          return _generatePattern(
            count >= 3
                ? ConversationPattern.chain3
                : ConversationPattern.singleReply,
            count,
            random,
          );
        }
        final placements = <(int, int)>[];
        for (int chainStart = 1; chainStart <= count - 2; chainStart++) {
          for (int pairStart = 1; pairStart <= count - 1; pairStart++) {
            final chainEnd = chainStart + 2;
            final pairEnd = pairStart + 1;
            if (chainEnd < pairStart || pairEnd < chainStart) {
              placements.add((chainStart, pairStart));
            }
          }
        }
        final separated = placements.where((placement) {
          final chainEnd = placement.$1 + 2;
          final pairEnd = placement.$2 + 1;
          return chainEnd + 1 < placement.$2 || pairEnd + 1 < placement.$1;
        }).toList();
        final candidates = separated.isNotEmpty ? separated : placements;
        final placement = candidates[random.nextInt(candidates.length)];
        final chainStart = placement.$1;
        final pairStart = placement.$2;
        return ConversationPlan(
          pattern: pattern,
          relations: [
            ReplyRelation(from: chainStart + 1, to: chainStart),
            ReplyRelation(from: chainStart + 2, to: chainStart + 1),
            ReplyRelation(from: pairStart + 1, to: pairStart),
          ],
        );
    }
  }

  static int _randomContiguousStart(int count, int length, Random random) {
    return random.nextInt(count - length + 1) + 1;
  }

  static ConversationPlan? restore({
    required String? storedPattern,
    required int count,
    required List<ReplyRelation> relations,
  }) {
    final pattern = ConversationPattern.fromStorage(storedPattern);
    if (pattern == null) return null;
    final plan = ConversationPlan(pattern: pattern, relations: relations);
    if (!plan.isValidFor(count) || !plan._matchesPattern()) return null;
    return plan;
  }

  bool _matchesPattern() {
    final participants = <int>{
      for (final relation in relations) ...[relation.from, relation.to],
    };
    switch (pattern) {
      case ConversationPattern.independent:
        return relations.isEmpty;
      case ConversationPattern.singleReply:
        return relations.length == 1 && participants.length == 2;
      case ConversationPattern.doubleReply:
        return relations.length == 2 && participants.length == 4;
      case ConversationPattern.chain3:
        return relations.length == 2 &&
            participants.length == 3 &&
            _hasChain(relations);
      case ConversationPattern.branch:
        return relations.length == 2 &&
            participants.length == 3 &&
            relations[0].to == relations[1].to;
      case ConversationPattern.mixed:
        if (relations.length != 3 || participants.length != 5) return false;
        for (int i = 0; i < relations.length; i++) {
          for (int j = i + 1; j < relations.length; j++) {
            if (_hasChain([relations[i], relations[j]])) return true;
          }
        }
        return false;
    }
  }

  static bool _hasChain(List<ReplyRelation> pair) {
    if (pair.length != 2) return false;
    return pair[0].from == pair[1].to || pair[1].from == pair[0].to;
  }
}

class CachedReplyChunk {
  final List<ReplyItem> replies;
  final ConversationPlan? conversation;

  const CachedReplyChunk({required this.replies, required this.conversation});
}
