<?php
if (!defined('ABSPATH')) exit;

/** Ordyx calls back here (signed with the shop key): a waybill was made or cancelled, or the order was cancelled in Ordyx. */
class Ordyx_Rest {
    const WINDOW = 300; // seconds a signed call stays valid

    public static function init() {
        add_action('rest_api_init', function () {
            register_rest_route('ordyx/v1', '/order', [
                'methods'             => 'POST',
                'callback'            => [__CLASS__, 'handle'],
                'permission_callback' => [__CLASS__, 'verify'],
            ]);
        });
        add_action('woocommerce_order_details_after_order_table', [__CLASS__, 'tracking_block']);
        add_action('woocommerce_email_order_meta', [__CLASS__, 'tracking_email'], 10, 3);
        add_action('woocommerce_admin_order_data_after_shipping_address', [__CLASS__, 'admin_block']);
    }

    public static function verify(WP_REST_Request $request) {
        $key = Ordyx_Api::key();
        $ts = (string) $request->get_header('x-ordyx-timestamp');
        $sig = (string) $request->get_header('x-ordyx-signature');
        if ($key === '' || $ts === '' || $sig === '' || !ctype_digit($ts)) return false;
        if (abs(time() - (int) $ts) > self::WINDOW) return false;
        return hash_equals(hash_hmac('sha256', $ts . '.' . $request->get_body(), $key), $sig);
    }

    public static function handle(WP_REST_Request $request) {
        $b = $request->get_json_params();
        $order = wc_get_order((int) ($b['wcId'] ?? 0));
        if (!$order) return new WP_REST_Response(['error' => 'not found'], 404);
        $event = (string) ($b['event'] ?? '');
        if ($event === 'shipped') {
            $order->update_meta_data('_ordyx_waybill', sanitize_text_field((string) ($b['number'] ?? '')));
            $order->update_meta_data('_ordyx_courier', sanitize_text_field((string) ($b['courierName'] ?? '')));
            $order->update_meta_data('_ordyx_track_url', esc_url_raw((string) ($b['trackUrl'] ?? '')));
            $order->update_meta_data('_ordyx_tracking_page', esc_url_raw((string) ($b['trackingPage'] ?? '')));
            $order->add_order_note(sprintf('Товарителница %s № %s. Проследяване за клиента: %s', $b['courierName'] ?? '', $b['number'] ?? '', $b['trackingPage'] ?? ''));
            if (Ordyx_Api::complete_on_ship() && in_array($order->get_status(), ['processing', 'on-hold', 'pending'], true)) {
                $order->update_meta_data('_ordyx_completed', 1);
                $order->save();
                $order->update_status('completed', 'Ordyx: пратката е изпратена');
            } else {
                $order->save();
            }
        } elseif ($event === 'waybill_cancelled') {
            foreach (['_ordyx_waybill', '_ordyx_courier', '_ordyx_track_url'] as $m) $order->delete_meta_data($m);
            $order->add_order_note('Ordyx: товарителницата е анулирана');
            if ($order->get_meta('_ordyx_completed') && $order->get_status() === 'completed') {
                $order->delete_meta_data('_ordyx_completed');
                $order->save();
                $order->update_status('processing', 'Ordyx: товарителницата е анулирана');
            } else {
                $order->save();
            }
        } elseif ($event === 'cancelled') {
            if ($order->get_status() !== 'cancelled') {
                $order->update_meta_data('_ordyx_by_ordyx', 1);
                $order->save();
                $order->update_status('cancelled', 'Ordyx: поръчката е отказана');
            }
        } else {
            return new WP_REST_Response(['error' => 'event'], 400);
        }
        return ['ok' => true];
    }

    private static function line(WC_Order $order) {
        $n = (string) $order->get_meta('_ordyx_waybill');
        if ($n === '') return '';
        $page = (string) $order->get_meta('_ordyx_tracking_page');
        $courier = (string) $order->get_meta('_ordyx_courier');
        return ['number' => $n, 'courier' => $courier, 'page' => $page, 'track' => (string) $order->get_meta('_ordyx_track_url')];
    }

    public static function tracking_block($order) {
        $l = self::line($order);
        if (!$l) return;
        echo '<section class="ordyx-tracking"><h2>Пратка</h2><p>' . esc_html(trim($l['courier'] . ' № ' . $l['number']));
        if ($l['page']) echo ' · <a href="' . esc_url($l['page']) . '" target="_blank" rel="noopener">Къде е пратката ми</a>';
        echo '</p></section>';
    }

    public static function tracking_email($order, $sent_to_admin, $plain_text) {
        $l = self::line($order);
        if (!$l) return;
        if ($plain_text) { echo "\nПратка: " . $l['courier'] . ' № ' . $l['number'] . ($l['page'] ? ' — ' . $l['page'] : '') . "\n"; return; }
        echo '<p><b>Пратка:</b> ' . esc_html(trim($l['courier'] . ' № ' . $l['number']));
        if ($l['page']) echo ' · <a href="' . esc_url($l['page']) . '">Къде е пратката ми</a>';
        echo '</p>';
    }

    public static function admin_block($order) {
        $type = (string) $order->get_meta('_ordyx_type');
        $l = self::line($order);
        if (!$type && !$l) return;
        echo '<p><b>Ordyx</b><br>';
        if ($type) echo esc_html(Ordyx_Api::TYPES[$type] ?? $type) . ($order->get_meta('_ordyx_office_text') ? ': ' . esc_html($order->get_meta('_ordyx_office_text')) : '') . '<br>';
        if ($l) echo esc_html(trim($l['courier'] . ' № ' . $l['number'])) . ($l['track'] ? ' · <a href="' . esc_url($l['track']) . '" target="_blank" rel="noopener">при куриера</a>' : '');
        if ($order->get_meta('_ordyx_pending') === 'retry') echo '<span style="color:#b32d2e">Не е изпратена в Ordyx: ' . esc_html((string) $order->get_meta('_ordyx_error')) . '</span>';
        echo '</p>';
    }
}
