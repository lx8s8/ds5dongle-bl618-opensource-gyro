#include "boot_store.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static unsigned char memory[0x400000],original[0x400000];
static int fail_operation=-1,operation,partial;
static void p16(uint8_t*p,unsigned v){p[0]=v;p[1]=v>>8;}
static void p32(uint8_t*p,unsigned v){p16(p,v);p16(p+2,v>>16);}
static unsigned u32(const uint8_t*p){return p[0]|p[1]<<8|p[2]<<16|((unsigned)p[3]<<24);}
static int read_flash(void*c,uint32_t a,uint8_t*p,size_t n){(void)c;assert(a<=sizeof memory&&n<=sizeof memory-a);memcpy(p,memory+a,n);return 0;}
static void writable(uint32_t a,size_t n){assert((a>=0xE000&&a+n<=0x10000)||(a>=BM_RECORD0&&a+n<=BM_RECORD1+4096));}
static int erase_flash(void*c,uint32_t a,size_t n){(void)c;writable(a,n);assert(!(a%4096)&&n==4096);bool fail=operation++==fail_operation;if(fail&&n>(unsigned)partial)n=partial;memset(memory+a,255,n);return fail?-1:0;}
static int write_flash(void*c,uint32_t a,const uint8_t*p,size_t n){(void)c;writable(a,n);bool fail=operation++==fail_operation;if(fail&&n>(unsigned)partial)n=partial;for(size_t i=0;i<n;i++){assert((memory[a+i]&p[i])==p[i]);memory[a+i]&=p[i];}return fail?-1:0;}
static const bm_flash flash={NULL,read_flash,erase_flash,write_flash};
static bm_record sample(void){bm_record r={.generation=1,.selected=0};for(int i=0;i<2;i++){r.image[i].address=i?0x210000:0x10000;r.image[i].capacity=i?0x120000:0x140000;r.image[i].image_length=0xD0000;memset(r.image[i].sha256,0x45+i,32);strcpy(r.image[i].version,i?"upstream-3.24H":"3.18G2.3");}return r;}
static void make_table(uint8_t*p,unsigned slot){
 memset(p,255,4096);memset(p,0,16+7*36+4);p32(p,0x54504642);p16(p+6,7);p32(p+12,bm_crc32(p,12));
 const char*names[]={"Boot2","FW","media","PSM","KEY","DATA","factory"};
 unsigned types[]={16,0,2,3,4,5,6};
 unsigned a[][2]={{0,0},{0x10000,0x210000},{0x150000,0x378000},{0x330000,0x3E9000},{0x338000,0x3F1000},{0x33A000,0x3F3000},{0x3F8000,0}};
 unsigned n[][2]={{0xE000,0},{0x140000,0x120000},{0x71000,0x71000},{0x8000,0x8000},{0x2000,0x2000},{0x5000,0x5000},{0x8000,0}};
 for(int i=0;i<7;i++){uint8_t*q=p+16+i*36;q[0]=types[i];q[2]=(i>=1&&i<=5)?slot:0;strcpy((char*)q+3,names[i]);for(int j=0;j<2;j++){p32(q+12+j*4,a[i][j]);p32(q+20+j*4,n[i][j]);}}
 p32(p+16+7*36,bm_crc32(p+16,7*36));
}
static void reset(void){memcpy(memory,original,sizeof memory);fail_operation=-1;operation=partial=0;}
static void protected_unchanged(void){assert(!memcmp(memory,original,0xE000));assert(!memcmp(memory+0x10000,original+0x10000,BM_RECORD0-0x10000));assert(!memcmp(memory+BM_RECORD1+4096,original+BM_RECORD1+4096,sizeof memory-BM_RECORD1-4096));}
static void check_view(unsigned slot){
 uint8_t *a=memory+0xE000,*b=memory+0xF000,*p=a;
 if(!memcmp(b,"BFPT",4)&&u32(b+8)>u32(a+8))p=b;
 for(int i=0;i<7;i++)if(i>=1&&i<=5)assert(p[16+i*36+2]==slot);
}
int main(void){
 assert(bm_crc32((uint8_t*)"123456789",9)==0xCBF43926);
 memset(original,0xA5,sizeof original);memset(original+BM_RECORD0,255,8192);make_table(original+0xE000,0);memset(original+0xF000,255,4096);
 bm_record r=sample(),out;uint8_t encoded[256];bm_encode(&r,encoded);assert(bm_decode(encoded,&out));memcpy(original+BM_RECORD0,encoded,256);
 for(int i=0;i<256;i++){encoded[i]^=1;assert(!bm_decode(encoded,&out));encoded[i]^=1;}
 reset();assert(bm_load(&flash,&out)==0&&out.selected==0);assert(bm_select(&flash,0,&out)&&operation==0);
 assert(bm_select(&flash,1,&out)&&out.selected==1&&out.generation==2);assert(bm_partition_select(&flash,1));check_view(1);protected_unchanged();
 assert(bm_select(&flash,0,&out)&&bm_partition_select(&flash,0));check_view(0);protected_unchanged();
 assert(bm_request_manager(&flash,true,&out)&&out.manage==1&&out.selected==0);
 assert(bm_request_manager(&flash,false,&out)&&out.manage==0);protected_unchanged();
 /* Every byte boundary of the metadata erase/body/CRC write, then reboot. */
 const int lengths[]={4096,252,4};
 unsigned failures=0;
 for(int op=0;op<3;op++)for(int cut=0;cut<=lengths[op];cut++){
  reset();fail_operation=op;partial=cut;(void)bm_select(&flash,1,&out);fail_operation=-1;
  assert(bm_load(&flash,&out)>=0);assert(out.selected<=1);
  assert(bm_partition_select(&flash,out.selected));check_view(out.selected);protected_unchanged();failures++;
 }
 /* Same fault boundaries for table publication. Reboot repairs the view from
  * the already committed metadata, without touching either writable bank. */
 const int pt_lengths[]={4096,16+7*36,4};
 for(int op=0;op<3;op++)for(int cut=0;cut<=pt_lengths[op];cut++){
  reset();assert(bm_select(&flash,1,&out));operation=0;fail_operation=op;partial=cut;(void)bm_partition_select(&flash,1);fail_operation=-1;
  assert(bm_load(&flash,&out)>=0&&out.selected==1);assert(bm_partition_select(&flash,1));check_view(1);protected_unchanged();failures++;
 }
 reset();assert(!bm_select(&flash,2,&out));assert(!bm_partition_select(&flash,2));assert(operation==0);
 /* Existing single-firmware layout is not silently migrated by boot code. */
 memory[0xE000+16+36+24]^=1;p32(memory+0xE000+16+7*36,bm_crc32(memory+0xE000+16,7*36));assert(!bm_partition_select(&flash,1)&&operation==0);
 reset();memset(memory+BM_RECORD0,255,8192);assert(bm_load(&flash,&out)<0&&!bm_select(&flash,1,&out));
 reset();r.generation=~0u;bm_encode(&r,memory+BM_RECORD0);assert(!bm_select(&flash,1,&out));
 bm_gesture g={0};assert(bm_button(&g,false,1999)==BM_WAIT);assert(bm_button(&g,false,2000)==BM_BOOT_CURRENT);
 memset(&g,0,sizeof g);assert(bm_button(&g,true,100)==BM_WAIT);assert(bm_button(&g,false,110)==BM_WAIT);assert(bm_button(&g,false,2000)==BM_BOOT_CURRENT);
 memset(&g,0,sizeof g);assert(bm_button(&g,true,100)==BM_WAIT);assert(bm_button(&g,false,150)==BM_BOOT_OTHER);
 memset(&g,0,sizeof g);assert(bm_button(&g,true,100)==BM_WAIT);assert(bm_button(&g,true,1100)==BM_MANAGE);
 printf("boot store: two-way selection, %u interrupted commits, isolated data, invalid layouts, overflow and boot gestures passed\n",failures);
 return 0;
}
