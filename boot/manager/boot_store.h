#ifndef DS5_BOOT_STORE_H
#define DS5_BOOT_STORE_H
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

/* Experimental LCTech BL616 / FS layout. Neither normal release packaging nor
 * the existing application enables or installs this boot manager. */
#define BM_RECORD_SIZE 256u
#define BM_RECORD0 0x340000u
#define BM_RECORD1 0x341000u
#define BM_SECTOR_SIZE 4096u
#define BM_ROOT_LIMIT 0xE000u
#define BM_SLOT_COUNT 2u
#define BM_BOARD_LCTECH_FS 1u

typedef struct {
 uint32_t address, capacity, image_length;
 uint8_t sha256[32];
 char version[20];
} bm_image;
typedef struct {
 uint32_t generation;
 uint8_t selected, manage;
 bm_image image[BM_SLOT_COUNT];
} bm_record;
typedef struct {
 void *context;
 int (*read)(void *,uint32_t,uint8_t *,size_t);
 int (*erase)(void *,uint32_t,size_t);
 int (*write)(void *,uint32_t,const uint8_t *,size_t);
} bm_flash;

uint32_t bm_crc32(const uint8_t *,size_t);
bool bm_decode(const uint8_t[BM_RECORD_SIZE],bm_record *);
void bm_encode(const bm_record *,uint8_t[BM_RECORD_SIZE]);
int bm_load(const bm_flash *,bm_record *);
bool bm_select(const bm_flash *,uint8_t,bm_record *);
bool bm_request_manager(const bm_flash *,bool,bm_record *);
/* Publish FW and all writable partition views in ONE CRC-protected table.
 * Root manager is entered by ROM, independently of this application table. */
bool bm_partition_select(const bm_flash *,uint8_t);

typedef enum { BM_WAIT,BM_BOOT_CURRENT,BM_BOOT_OTHER,BM_MANAGE } bm_gesture_result;
typedef struct {uint32_t pressed_at;bool down;} bm_gesture;
bm_gesture_result bm_button(bm_gesture *,bool,uint32_t);
#endif
