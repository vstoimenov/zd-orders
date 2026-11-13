<?php
if (!defined('ABSPATH')) exit;

/**
 * Stock to Ordyx: every product (and variation) whose stock WooCommerce manages is sent with its name, SKU and number.
 * A change is sent at the end of the request that made it (without making anyone wait); all of them once a day and with the button.
 */
class Ordyx_Stock {
    const BATCH = 200;
    private static $changed = [];

    public static function init() {
        add_action('woocommerce_product_set_stock', [__CLASS__, 'changed']);
        add_action('woocommerce_variation_set_stock', [__CLASS__, 'changed']);
        add_action('shutdown', [__CLASS__, 'flush']);
        add_action('ordyx_stock_daily', [__CLASS__, 'send_all']);
        add_action('admin_post_ordyx_stock', [__CLASS__, 'button']);
        if (!wp_next_scheduled('ordyx_stock_daily')) wp_schedule_event(time() + HOUR_IN_SECONDS, 'daily', 'ordyx_stock_daily');
    }

    /** What Ordyx gets for one product, or null when WooCommerce does not count its stock (a variation that shares its parent's is sent as the parent). */
    public static function item($product) {
        if (!$product || !$product->managing_stock()) return null;
        if ($product->is_type('variation') && $product->get_manage_stock() === 'parent') return null;
        $qty = $product->get_stock_quantity();
        if ($qty === null) return null;
        return ['name' => wp_strip_all_tags($product->get_name()), 'sku' => (string) $product->get_sku(), 'stock' => (int) $qty];
    }

    public static function changed($product) {
        if (is_numeric($product)) $product = wc_get_product($product);
        if ($product) self::$changed[$product->get_id()] = $product->get_id();
    }

    /** Changes of this request, in one call that does not wait for the answer; one that is lost is caught by the daily send. */
    public static function flush() {
        if (!self::$changed || Ordyx_Api::key() === '') return;
        $items = [];
        foreach (self::$changed as $id) {
            $it = self::item(wc_get_product($id));
            if ($it) $items[] = $it;
        }
        self::$changed = [];
        if ($items) Ordyx_Api::send_stock(array_slice($items, 0, self::BATCH), 3, false);
    }

    /** Every counted product, in batches. @return array{ok:bool,count:int,error:string} */
    public static function send_all() {
        if (Ordyx_Api::key() === '') return ['ok' => false, 'count' => 0, 'error' => 'Няма ключ на магазина'];
        $count = 0;
        for ($page = 1; $page <= 100; $page++) {
            $products = wc_get_products(['type' => ['simple', 'variable', 'variation'], 'status' => ['publish', 'private'], 'limit' => self::BATCH, 'page' => $page, 'orderby' => 'ID', 'order' => 'ASC']);
            if (!$products) break;
            $items = [];
            foreach ($products as $p) { $it = self::item($p); if ($it) $items[] = $it; }
            if ($items) {
                $r = Ordyx_Api::send_stock($items, 20);
                if (!$r['ok']) return ['ok' => false, 'count' => $count, 'error' => $r['error']];
                $count += count($items);
            }
            if (count($products) < self::BATCH) break;
        }
        return ['ok' => true, 'count' => $count, 'error' => ''];
    }

    /** „Изпрати наличностите сега“. */
    public static function button() {
        if (!current_user_can('manage_woocommerce') || !check_admin_referer('ordyx_stock')) wp_die('Нямате право');
        $r = self::send_all();
        update_option('ordyx_last_stock', ['at' => time(), 'ok' => $r['ok'], 'text' => $r['ok']
            ? ($r['count'] ? 'Изпратени ' . $r['count'] . ' продукта с наличност' : 'Няма продукти, на които WooCommerce води наличност (Inventory → Manage stock)')
            : $r['error']]);
        wp_safe_redirect(admin_url('admin.php?page=ordyx&stock=1'));
        exit;
    }
}
