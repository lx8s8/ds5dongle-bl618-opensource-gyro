#include "led_status.h"
#include "board_config.h"
#include <assert.h>
#include <stdio.h>
static struct bflb_device_s gpio;
static unsigned pins;
void bflb_gpio_init(struct bflb_device_s *d, uint32_t p, uint32_t cfg) { }
void bflb_gpio_set(struct bflb_device_s *d, uint32_t p) { pins |= 1u << p; }
void bflb_gpio_reset(struct bflb_device_s *d, uint32_t p) { pins &= ~(1u << p); }
struct bflb_device_s *bflb_device_get_by_name(const char *name) { return &gpio; }
int main(void)
{
    led_status_init(); led_status_set(LED_GREEN_SOLID); unsigned connected = pins;
    led_status_notify(4); led_status_tick(); assert(led_status_get() == LED_GREEN_SOLID);
    for (int i = 0; i < 18; i++) led_status_tick();
    assert(led_status_get() == LED_GREEN_SOLID && pins == connected);
    led_status_notify(2); led_status_tick(); led_status_set(LED_BLINK_BATTERY); led_status_tick();
    assert(led_status_get() == LED_BLINK_BATTERY);
    led_status_notify(3); led_status_tick(); assert(led_status_get() == LED_BLINK_BATTERY);
    led_status_set(LED_BLUE_SOLID); led_status_lock(); unsigned locked = pins;
    led_status_notify(1); led_status_tick(); assert(led_status_get() == LED_BLUE_SOLID && pins == locked);
    led_status_unlock(); led_status_set(LED_OFF); unsigned off = pins;
    led_status_notify(1); for (int i = 0; i < 6; i++) led_status_tick();
    assert(led_status_get() == LED_OFF && pins == off);
    puts(BOARD_NAME ": notification restores LEDs and yields to battery/lock");
}
