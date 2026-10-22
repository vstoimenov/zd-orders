<?php
if (!defined('ABSPATH')) exit;

/**
 * Sends orders to Ordyx: cash on delivery at once, card/bank after the payment; cancelled/refunded → cancelled there.
 * A send that fails is retried by WP-Cron for 24 hours and shown in WooCommerce → Ordyx with „Изпрати пак“. Never blocks the checkout.
 */
class Ordyx_Sender {
    const RETRY_HOURS = 24;

    public static function init() {
        add_action('woocommerce_checkout_order_processed', [__CLASS__, 'on_new_order'], 20, 1);
        add_action('woocommerce_store_api_checkout_order_processed', function ($order) { self::on_new_order($order->get_id()); }, 20, 1);
        add_action('woocommerce_payment_complete', [__CLASS__, 'on_paid'], 20, 1);
        add_action('woocommerce_order_status_processing', [__CLASS__, 'on_paid_status'], 20, 1); // bank transfer / cheque marked paid by hand
        add_action('woocommerce_order_status_completed', [__CLASS__, 'on_paid_status'], 20, 1);
        add_action('woocommerce_order_status_cancelled', [__CLASS__, 'on_cancelled'], 20, 1);
        add_action('woocommerce_order_status_refunded', [__CLASS__, 'on_cancelled'], 20, 1);
        add_action('ordyx_retry', [__CLASS__, 'retry']);
        add_action('admin_post_ordyx_resend', [__CLASS__, 'resend']);
    }

    public static function on_new_order($order_id) {
        $order = wc_get_order($order_id);
        if (!$order || $order->get_meta('_ordyx_sent_at')) return;
        // cash on delivery goes now; anything else (card, bank transfer, cheque) only once it is paid (woocommerce_payment_complete)
        if ($order->get_payment_method() === 'cod' || $order->is_paid()) {
            self::send($order, 5);
        } else {
            $order->update_meta_data('_ordyx_pending', 'awaiting_payment');
            $order->save();
        }
    }

    public static function on_paid($order_id) {
        $order = wc_get_order($order_id);
        if (!$order || $order->get_meta('_ordyx_sent_at')) return;
        self::send($order, 5);
    }

    /** A non-COD order the shop marked paid by hand (bank transfer, cheque): woocommerce_payment_complete does not fire then. */
    public static function on_paid_status($order_id) {
        $order = wc_get_order($order_id);
        if (!$order || $order->get_meta('_ordyx_sent_at') || $order->get_meta('_ordyx_pending') !== 'awaiting_payment') return;
        if ($order->get_payment_method() !== 'cod' && !$order->is_paid()) return;
        self::send($order, 8);
    }

    public static function on_cancelled($order_id) {
        $order = wc_get_order($order_id);
        if (!$order || $order->get_meta('_ordyx_by_ordyx')) return; // Ordyx cancelled it: nothing to tell it
        $order->delete_meta_data('_ordyx_pending');
        $order->save();
        // a send that timed out may still have landed in Ordyx: tell it whenever a send was tried; "not found" is fine
        if (!$order->get_meta('_ordyx_sent_at') && !(int) $order->get_meta('_ordyx_attempts')) return;
        $r = Ordyx_Api::cancel_order($order);
        $order->add_order_note($r['ok'] || $r['status'] === 404 ? 'Ordyx: отказът е предаден' : 'Ordyx: отказът не стигна — ' . $r['error']);
    }

    /** One try now; a failure queues the order for the cron. */
    public static function send(WC_Order $order, $timeout = 8) {
        $r = Ordyx_Api::send_order($order, $timeout);
        if ($r['ok']) {
            $order->update_meta_data('_ordyx_sent_at', time());
            $order->delete_meta_data('_ordyx_pending');
            $order->delete_meta_data('_ordyx_error');
            $order->add_order_note(!empty($r['data']['locked']) ? 'Ordyx: поръчката вече има товарителница, промяната не е приложена' : 'Изпратена в Ordyx');
            $order->save();
            return true;
        }
        if (!$order->get_meta('_ordyx_first_try')) $order->update_meta_data('_ordyx_first_try', time());
        $order->update_meta_data('_ordyx_pending', 'retry');
        $order->update_meta_data('_ordyx_error', $r['error']);
        $order->update_meta_data('_ordyx_attempts', (int) $order->get_meta('_ordyx_attempts') + 1);
        $order->save();
        if (!wp_next_scheduled('ordyx_retry')) wp_schedule_single_event(time() + 5 * MINUTE_IN_SECONDS, 'ordyx_retry');
        return false;
    }

    /** Orders still to be sent (newest first): failed sends, or (with $awaiting) non-COD orders waiting to be paid. */
    public static function pending($limit = 50, $awaiting = false) {
        return wc_get_orders(['limit' => $limit, 'orderby' => 'date', 'order' => 'DESC', 'meta_key' => '_ordyx_pending', 'meta_value' => $awaiting ? 'awaiting_payment' : 'retry']);
    }

    public static function retry() {
        $again = false;
        foreach (self::pending() as $order) {
            $first = (int) $order->get_meta('_ordyx_first_try');
            if ($first && time() - $first > self::RETRY_HOURS * HOUR_IN_SECONDS) continue; // the shop sends it by hand from the settings
            if (!self::send($order, 10)) $again = true;
        }
        if ($again && !wp_next_scheduled('ordyx_retry')) wp_schedule_single_event(time() + 10 * MINUTE_IN_SECONDS, 'ordyx_retry');
    }

    /** „Изпрати пак“ from WooCommerce → Ordyx. */
    public static function resend() {
        if (!current_user_can('manage_woocommerce') || !check_admin_referer('ordyx_resend')) wp_die('Нямате право');
        $order = wc_get_order((int) ($_GET['order'] ?? 0));
        if ($order) self::send($order, 10);
        wp_safe_redirect(admin_url('admin.php?page=ordyx&resent=' . ($order ? (int) $order->get_id() : 0)));
        exit;
    }
}
