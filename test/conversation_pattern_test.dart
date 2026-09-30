import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/models/conversation_pattern.dart';

void main() {
  group('ConversationPlan', () {
    for (final pattern in ConversationPattern.values) {
      test('${pattern.name} generates the expected structure', () {
        final plan = ConversationPlan.forPattern(
          pattern: pattern,
          count: 10,
          random: Random(42),
        );

        expect(plan.pattern, pattern);
        expect(plan.isValidFor(10), isTrue);
        final restored = ConversationPlan.restore(
          storedPattern: pattern.name,
          count: 10,
          relations: plan.relations,
        );
        expect(restored, isNotNull);

        switch (pattern) {
          case ConversationPattern.independent:
            expect(plan.relations, isEmpty);
          case ConversationPattern.singleReply:
            expect(plan.relations, hasLength(1));
            expect(plan.relations.single.from, plan.relations.single.to + 1);
          case ConversationPattern.doubleReply:
            expect(plan.relations, hasLength(2));
            expect(
              plan.relations.every(
                (relation) => relation.from == relation.to + 1,
              ),
              isTrue,
            );
            expect(_participants(plan), hasLength(4));
          case ConversationPattern.chain3:
            expect(plan.relations, hasLength(2));
            final relations = plan.relations;
            expect(relations[0].from, relations[0].to + 1);
            expect(relations[1].to, relations[0].from);
            expect(relations[1].from, relations[0].to + 2);
          case ConversationPattern.branch:
            expect(plan.relations, hasLength(2));
            final relations = plan.relations;
            expect(relations[0].from, relations[0].to + 1);
            expect(relations[1].to, relations[0].to);
            expect(relations[1].from, relations[0].to + 2);
          case ConversationPattern.mixed:
            expect(plan.relations, hasLength(3));
            expect(_participants(plan), hasLength(5));
            final chain = plan.relations.take(2).toList();
            final pair = plan.relations.last;
            expect(chain[0].from, chain[0].to + 1);
            expect(chain[1].to, chain[0].from);
            expect(chain[1].from, chain[0].to + 2);
            expect(pair.from, pair.to + 1);
            expect(
              {
                chain[0].to,
                chain[0].from,
                chain[1].from,
              }.intersection({pair.to, pair.from}),
              isEmpty,
            );
        }
      });
    }

    test('small counts safely fall back', () {
      for (int count = 0; count <= 10; count++) {
        for (final pattern in ConversationPattern.values) {
          final plan = ConversationPlan.forPattern(
            pattern: pattern,
            count: count,
            random: Random(count + pattern.index),
          );
          expect(plan.isValidFor(count), isTrue);
        }
      }
    });

    test('new plans never generate separated conversation groups', () {
      for (final pattern in ConversationPattern.values) {
        for (int seed = 0; seed < 1000; seed++) {
          final plan = ConversationPlan.forPattern(
            pattern: pattern,
            count: 10,
            random: Random(seed),
          );
          expect(_usesOnlyContiguousGroups(plan), isTrue);
        }
      }
    });

    test('density uses unique relation participants', () {
      const expectedDensity = {
        ConversationPattern.independent: 0.0,
        ConversationPattern.singleReply: 0.2,
        ConversationPattern.doubleReply: 0.4,
        ConversationPattern.chain3: 0.3,
        ConversationPattern.branch: 0.3,
        ConversationPattern.mixed: 0.5,
      };
      for (final entry in expectedDensity.entries) {
        final plan = ConversationPlan.forPattern(
          pattern: entry.key,
          count: 10,
          random: Random(entry.key.index),
        );
        expect(plan.densityFor(10), entry.value);
      }
    });

    test('1000 selections stay near the configured weights', () {
      final random = Random(20260904);
      final counts = {
        for (final pattern in ConversationPattern.values) pattern: 0,
      };
      for (int i = 0; i < 1000; i++) {
        final pattern = ConversationPlan.generate(
          count: 10,
          random: random,
        ).pattern;
        counts[pattern] = counts[pattern]! + 1;
      }

      const expected = {
        ConversationPattern.independent: 100,
        ConversationPattern.singleReply: 200,
        ConversationPattern.doubleReply: 250,
        ConversationPattern.chain3: 200,
        ConversationPattern.branch: 150,
        ConversationPattern.mixed: 100,
      };
      for (final entry in expected.entries) {
        expect(
          counts[entry.key],
          inInclusiveRange(entry.value - 50, entry.value + 50),
        );
      }
    });

    test('legacy chunks are not classified', () {
      expect(
        ConversationPlan.restore(
          storedPattern: null,
          count: 10,
          relations: const [ReplyRelation(from: 4, to: 3)],
        ),
        isNull,
      );
    });
  });
}

Set<int> _participants(ConversationPlan plan) => {
  for (final relation in plan.relations) ...[relation.from, relation.to],
};

bool _usesOnlyContiguousGroups(ConversationPlan plan) {
  final relations = plan.relations;
  switch (plan.pattern) {
    case ConversationPattern.independent:
      return relations.isEmpty;
    case ConversationPattern.singleReply:
    case ConversationPattern.doubleReply:
      return relations.every((relation) => relation.from == relation.to + 1);
    case ConversationPattern.chain3:
      return relations.length == 2 &&
          relations[0].from == relations[0].to + 1 &&
          relations[1].to == relations[0].from &&
          relations[1].from == relations[0].to + 2;
    case ConversationPattern.branch:
      return relations.length == 2 &&
          relations[0].from == relations[0].to + 1 &&
          relations[1].to == relations[0].to &&
          relations[1].from == relations[0].to + 2;
    case ConversationPattern.mixed:
      if (relations.length != 3) return false;
      final chain = relations.take(2).toList();
      final pair = relations.last;
      final chainPositions = {chain[0].to, chain[0].from, chain[1].from};
      final pairPositions = {pair.to, pair.from};
      return chain[0].from == chain[0].to + 1 &&
          chain[1].to == chain[0].from &&
          chain[1].from == chain[0].to + 2 &&
          pair.from == pair.to + 1 &&
          chainPositions.intersection(pairPositions).isEmpty;
  }
}
