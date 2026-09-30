package com.aisoku.app

import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ImageView
import com.google.android.gms.ads.nativead.MediaView
import com.google.android.gms.ads.nativead.NativeAd
import com.google.android.gms.ads.nativead.NativeAdView
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugins.googlemobileads.NativeAdFactory

class NewsNativeAdFactory(private val context: Context, private val channel: MethodChannel) : NativeAdFactory {
    override fun createNativeAd(ad: NativeAd, customOptions: MutableMap<String, Any>?): NativeAdView {
        val width = ((customOptions?.get("width") as? Number)?.toDouble() ?: 320.0)
        val view = NativeAdView(context).apply { setBackgroundColor(Color.WHITE) }
        val column = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        val textWidth = context.dp(width.toInt() - 144).coerceAtLeast(1)
        view.addView(column, FrameLayout.LayoutParams(textWidth, FrameLayout.LayoutParams.WRAP_CONTENT).apply {
            leftMargin = context.dp(8); topMargin = context.dp(4)
        })
        val header = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
        val badge = context.assetText("【広告】", 11f).apply { minHeight = context.dp(15); minWidth = context.dp(15) }
        val icon = context.icon(ad.icon?.drawable)
        header.addView(badge)
        header.addView(icon, LinearLayout.LayoutParams(context.dp(24), context.dp(24)))
        column.addView(header)
        view.iconView = icon
        val advertiser = context.assetText(ad.advertiser, 11f, 25)
        val headline = context.assetText(ad.headline, 14f, 25)
        val body = context.assetText(ad.body, 11f, 90)
        val cta = context.assetText(ad.callToAction, 12f, 15).apply { setTextColor(Color.rgb(0, 80, 170)) }
        column.addView(advertiser); column.addView(headline); column.addView(body); column.addView(cta)
        view.advertiserView = advertiser; view.headlineView = headline; view.bodyView = body; view.callToActionView = cta
        // Optional text is omitted as a whole when it cannot fit. Never truncate
        // below Google's minimum character limits to squeeze it into the card.
        column.measureAtWidth(textWidth)
        if (column.measuredHeight > context.dp(136)) { body.visibility = View.GONE; column.measureAtWidth(textWidth) }
        if (column.measuredHeight > context.dp(136)) { advertiser.visibility = View.GONE; column.measureAtWidth(textWidth) }
        val media = MediaView(context)
        media.setImageScaleType(ImageView.ScaleType.FIT_CENTER)
        view.addView(media, FrameLayout.LayoutParams(context.dp(120), context.dp(120), Gravity.END or Gravity.TOP).apply {
            topMargin = context.dp(24)
        })
        view.mediaView = media
        media.mediaContent = ad.mediaContent
        view.addChoices(context)
        view.setNativeAd(ad)
        if (textWidth <= 0 || column.measuredHeight > context.dp(136)) {
            Handler(Looper.getMainLooper()).post { channel.invokeMethod("invalidLayout", mapOf("adInstanceId" to customOptions?.get("adInstanceId"))) }
        }
        var measuredWidth = context.dp(width.toInt())
        view.addOnLayoutChangeListener { _, left, _, right, _, _, _, _, _ ->
            val currentWidth = right - left
            if (currentWidth > 0 && currentWidth != measuredWidth) {
                measuredWidth = currentWidth
                val currentTextWidth = (currentWidth - context.dp(144)).coerceAtLeast(1)
                column.layoutParams = column.layoutParams.apply { this.width = currentTextWidth }
                body.visibility = if (ad.body.isNullOrBlank()) View.GONE else View.VISIBLE
                advertiser.visibility = if (ad.advertiser.isNullOrBlank()) View.GONE else View.VISIBLE
                column.measureAtWidth(currentTextWidth)
                if (column.measuredHeight > context.dp(136)) { body.visibility = View.GONE; column.measureAtWidth(currentTextWidth) }
                if (column.measuredHeight > context.dp(136)) { advertiser.visibility = View.GONE; column.measureAtWidth(currentTextWidth) }
                if (column.measuredHeight > context.dp(136)) {
                    Handler(Looper.getMainLooper()).post { channel.invokeMethod("invalidLayout", mapOf("adInstanceId" to customOptions?.get("adInstanceId"))) }
                }
            }
        }
        return view
    }
}
