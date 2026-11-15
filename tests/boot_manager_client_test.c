#include "boot_store.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
bool boot_manager_request(void);
static uint8_t memory[0x400000];
static unsigned mutations;
int bflb_flash_read(uint32_t a,uint8_t*p,uint32_t n){assert(a+n<=sizeof memory);memcpy(p,memory+a,n);return 0;}
int bflb_flash_erase(uint32_t a,uint32_t n){assert(a>=BM_RECORD0&&a+n<=BM_RECORD1+4096);memset(memory+a,255,n);mutations++;return 0;}
int bflb_flash_write(uint32_t a,uint8_t*p,uint32_t n){assert(a>=BM_RECORD0&&a+n<=BM_RECORD1+4096);memcpy(memory+a,p,n);mutations++;return 0;}
static void p32(uint8_t*p,unsigned v){for(int i=0;i<4;i++)p[i]=v>>(8*i);}
int main(void){
 memset(memory,255,sizeof memory);assert(!boot_manager_request()&&!mutations);
 memset(memory,0,256);memcpy(memory,"BFNP",4);p32(memory+124,0x2000);p32(memory+252,bm_crc32(memory,252));assert(!boot_manager_request()&&!mutations);
 p32(memory+124,0x1000);p32(memory+252,bm_crc32(memory,252));assert(!boot_manager_request()&&!mutations);
 p32(memory+124,0x2000);p32(memory+252,bm_crc32(memory,252));
 memcpy(memory+0xFE0,"DS5-DBM1-ROOT\0\0\0",16);
 bm_record r={.generation=1,.selected=0};
 for(int i=0;i<2;i++){r.image[i].address=i?0x210000:0x10000;r.image[i].capacity=i?0x120000:0x140000;r.image[i].image_length=0x80000;}
 bm_encode(&r,memory+BM_RECORD0);assert(boot_manager_request()&&mutations==3);
 bm_record out;assert(bm_decode(memory+BM_RECORD1,&out)&&out.manage==1&&out.selected==0);
 assert(boot_manager_request()&&mutations==3);
 puts("boot client: uninstalled rejection, root marker, pending request, write bounds and deduplication passed");
}
