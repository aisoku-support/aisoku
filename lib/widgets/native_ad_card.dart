import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:google_mobile_ads/google_mobile_ads.dart';

import '../config/ad_mob_config.dart';
import '../services/native_ad_slot.dart';

/// Slot ownership belongs to the category/controller, never to recycled rows.
class NativeAdCard extends StatefulWidget {
  final NativeAdSlot slot;
  final VoidCallback? onEnteredViewport;
  const NativeAdCard({super.key, required this.slot, this.onEnteredViewport});
  @override
  State<NativeAdCard> createState() => _NativeAdCardState();
}

class _NativeAdCardState extends State<NativeAdCard> {
  ScrollPosition? _position;
  bool _scheduled = false;
  final _adWidgetKey = GlobalKey();
  @override
  void initState() {
    super.initState();
    widget.slot.incrementUsage();
    widget.slot.addListener(_changed);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _position?.removeListener(_checkSoon);
    _position = Scrollable.maybeOf(context)?.position;
    _position?.addListener(_checkSoon);
    _checkSoon();
  }

  @override
  void didUpdateWidget(NativeAdCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.slot != widget.slot) {
      oldWidget.slot.decrementUsage();
      oldWidget.slot.removeListener(_changed);
      widget.slot.incrementUsage();
      widget.slot.addListener(_changed);
    }
    _checkSoon();
  }

  void _changed() {
    if (mounted) {
      setState(() {});
      _checkSoon();
    }
  }

  void _checkSoon() {
    if (_scheduled) return;
    _scheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _scheduled = false;
      if (!mounted) return;
      final box = context.findRenderObject();
      if (box is! RenderBox || !box.hasSize || box.size.isEmpty) return;
      final viewport = RenderAbstractViewport.maybeOf(box);
      if (viewport == null || viewport is! RenderBox) return;
      final viewportBox = viewport as RenderBox;
      if (!viewportBox.hasSize) return;
      final top = box.localToGlobal(Offset.zero, ancestor: viewportBox).dy;
      final extent = viewportBox.size.height;
      final entered = top < extent && top + box.size.height > 0;
      if (entered && !widget.slot.hasEnteredViewport) {
        widget.slot.hasEnteredViewport = true;
        widget.onEnteredViewport?.call();
      }
      if (widget.slot.unit == AdUnit.threadNative || top < extent * 2) {
        widget.slot.load(box.size.width, reason: 'viewport');
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    _checkSoon();
    final slot = widget.slot;
    if (slot.unit == AdUnit.threadNative &&
        slot.state == NativeSlotState.failed) {
      return const SizedBox.shrink();
    }
    return SizedBox(
      height: slot.height,
      width: double.infinity,
      child: slot.state == NativeSlotState.loaded
          ? (AdMobConfig.usePlaceholder
                ? Container(
                    decoration: BoxDecoration(
                      color: Theme.of(context).colorScheme.surfaceContainer,
                      border: Border.all(color: Theme.of(context).dividerColor),
                    ),
                    alignment: Alignment.center,
                    child: Text(
                      '広告枠 [Native: ${slot.unit.name}]',
                      style: const TextStyle(fontSize: 12, color: Colors.grey),
                    ),
                  )
                : (slot.ad != null
                      ? AdWidget(key: _adWidgetKey, ad: slot.ad!)
                      : null))
          : null,
    );
  }

  @override
  void dispose() {
    _position?.removeListener(_checkSoon);
    widget.slot.removeListener(_changed);
    widget.slot.decrementUsage();
    super.dispose();
  }
}
