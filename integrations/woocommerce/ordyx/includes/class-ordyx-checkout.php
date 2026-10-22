<?php
if (!defined('ABSPATH')) exit;

/** The classic (shortcode) checkout: the picker under the customer details, hidden fields, a check on „Place order“. */
class Ordyx_Checkout {
    public static function init() {
        if (Ordyx_Api::mode() !== 'checkout') return;
        add_action('wp_enqueue_scripts', [__CLASS__, 'scripts']);
        add_action('woocommerce_checkout_after_customer_details', [__CLASS__, 'render']);
        add_action('woocommerce_checkout_process', [__CLASS__, 'validate']);
        add_action('woocommerce_checkout_create_order', [__CLASS__, 'save'], 10, 2);
    }

    public static function scripts() {
        if (!function_exists('is_checkout') || !is_checkout() || is_order_received_page()) return;
        wp_enqueue_script('ordyx-widget', Ordyx_Api::browser_base() . '/checkout.js', [], ORDYX_VERSION, true);
        wp_localize_script('ordyx-widget', 'OrdyxWC', self::config());
        if (has_block('woocommerce/checkout')) {
            wp_enqueue_script('ordyx-checkout-blocks', ORDYX_URL . 'assets/checkout-blocks.js', ['ordyx-widget', 'wp-plugins', 'wp-element', 'wp-data', 'wc-blocks-checkout'], ORDYX_VERSION, true);
        } else {
            wp_enqueue_script('ordyx-checkout-classic', ORDYX_URL . 'assets/checkout-classic.js', ['ordyx-widget', 'jquery'], ORDYX_VERSION, true);
        }
    }

    public static function config() {
        return [
            'api'         => Ordyx_Api::browser_base(),
            'host'        => Ordyx_Api::host(),
            'rates'       => Ordyx_Shipping::rate_types(),
            'officeTypes' => Ordyx_Api::OFFICE_TYPES,
            'heading'     => 'Офис или автомат за доставка',
        ];
    }

    public static function render() {
        echo '<div id="ordyx-pick" class="ordyx-pick" hidden><h3>' . esc_html(self::config()['heading']) . '</h3><div id="ordyx-pick-widget"></div>';
        foreach (['type', 'office_id', 'office_text', 'city', 'post_code'] as $f) {
            echo '<input type="hidden" name="ordyx_' . esc_attr($f) . '" id="ordyx_' . esc_attr($f) . '" value="">';
        }
        echo '</div>';
    }

    /** The chosen office must be one of the courier's (when the list is at hand); never block the sale when Ordyx cannot be asked. */
    public static function check($type, $office_id) {
        if (!in_array($type, Ordyx_Api::OFFICE_TYPES, true)) return '';
        if ($office_id === '') return $type === 'boxnow_locker' ? 'Моля, изберете автомат на BOX NOW.' : 'Моля, изберете офис или автомат за доставка.';
        $courier = explode(':', $office_id)[0];
        $ids = Ordyx_Api::offices($courier);
        if (is_array($ids) && !isset($ids[$office_id])) return 'Избраният офис не е намерен — изберете отново от списъка.';
        return '';
    }

    public static function validate() {
        $type = Ordyx_Shipping::chosen_type();
        if (!$type) return;
        $err = self::check($type, sanitize_text_field(wp_unslash($_POST['ordyx_office_id'] ?? '')));
        if ($err) wc_add_notice($err, 'error');
    }

    public static function save($order, $data) {
        $type = Ordyx_Shipping::chosen_type();
        if (!$type) return;
        self::apply($order, $type, [
            'office_id'   => sanitize_text_field(wp_unslash($_POST['ordyx_office_id'] ?? '')),
            'office_text' => sanitize_text_field(wp_unslash($_POST['ordyx_office_text'] ?? '')),
            'city'        => sanitize_text_field(wp_unslash($_POST['ordyx_city'] ?? '')),
            'post_code'   => sanitize_text_field(wp_unslash($_POST['ordyx_post_code'] ?? '')),
        ]);
    }

    /** Writes the choice on the order; an office also becomes the shipping address, so emails and the order screen show it. */
    public static function apply(WC_Order $order, $type, array $v) {
        $order->update_meta_data('_ordyx_type', $type);
        if (!in_array($type, Ordyx_Api::OFFICE_TYPES, true)) return;
        $order->update_meta_data('_ordyx_office_id', $v['office_id']);
        $order->update_meta_data('_ordyx_office_text', $v['office_text']);
        $order->update_meta_data('_ordyx_city', $v['city']);
        $order->update_meta_data('_ordyx_post_code', $v['post_code']);
        if ($v['office_text'] !== '') {
            $order->set_shipping_address_1($v['office_text']);
            $order->set_shipping_address_2('');
            if ($v['city'] !== '') $order->set_shipping_city($v['city']);
            if ($v['post_code'] !== '') $order->set_shipping_postcode($v['post_code']);
            $order->set_shipping_country('BG');
            if ($order->get_shipping_first_name() === '' && $order->get_shipping_last_name() === '') {
                $order->set_shipping_first_name($order->get_billing_first_name());
                $order->set_shipping_last_name($order->get_billing_last_name());
            }
        }
    }
}
