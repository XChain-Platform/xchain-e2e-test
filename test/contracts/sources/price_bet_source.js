// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const MAX_ROUND = 1000000000
const MAX_WINDOW_BLOCKS = 1000000

const PRICE_BET = `var MAX_ROUND=${MAX_ROUND},MAX_WINDOW_BLOCKS=${MAX_WINDOW_BLOCKS};
module.exports={
meta:{name:'Price Bet',description:'Two-party binary option on an oracle price: the maker fixes the pair, strike, side and stake and a taker matches it, and once the agreed oracle round is published anyone can settle deterministically to the winning side, or return both stakes on an exact tie.',version:'1.2.0'},
abi:{version:1,methods:{fund:{summary:'Maker escrows their stake (BATCH after a DEPOSIT)',params:[]},accept:{summary:'Taker matches the stake and takes the opposite side (BATCH after a DEPOSIT)',params:[]},settle:{summary:'Pay the winner from the oracle round price (anyone, once the round exists)',params:[]},cancel:{summary:'Maker reclaims their stake while the bet is unmatched',params:[]},reclaim:{summary:'Void the bet and refund both sides if the oracle round never arrives',params:[]},info:{summary:'Read the bet terms and status',params:[],view:true}}},
initialize:function(x){
var a=x.getInputParam(0),p=x.getInputParam(1),k=x.getInputParam(2),o=x.getInputParam(3),t=x.getInputParam(4),m=x.getInputParam(5),r=x.getInputParam(6),w=x.getInputParam(7);
x.require(a,'maker required');x.require(p,'coinPair required');x.require(k&&x.math.gt(k,'0'),'strike must be positive');num(x,k,'strike');x.require(o==='OVER'||o==='UNDER','side must be OVER or UNDER');x.require(t,'tick required');x.require(m&&x.math.gt(m,'0'),'amount must be positive');num(x,m,'amount');int(x,r,1,MAX_ROUND,'settleRound');int(x,w,1,MAX_WINDOW_BLOCKS,'deadlineBlocks');r=parseInt(r,10);w=parseInt(w,10);x.require(!out(x,p,r),'settleRound is older than the retrievable oracle window');s(x,'maker',a);s(x,'coinPair',p);s(x,'strike',k);s(x,'side',o);s(x,'tick',t);s(x,'amount',m);s(x,'settleRound',String(r));s(x,'window',String(w));s(x,'status','INIT')},
fund:function(x){x.require(g(x,'status')==='INIT','bet not awaiting funds');x.require(x.getSourceAddress()===g(x,'maker'),'only the maker funds');x.require(ge(x,bal(x),g(x,'amount')),'insufficient deposit');s(x,'status','OPEN')},
accept:function(x){x.require(g(x,'status')==='OPEN','bet not open');var a=x.getSourceAddress();x.require(a!==g(x,'maker'),'maker cannot take their own bet');x.require(pr(x)===null,'settle round already published');x.require(!old(x),'settle round is older than the retrievable oracle window');var n=x.math.multiply(g(x,'amount'),'2');x.require(ge(x,bal(x),n),'insufficient deposit');s(x,'taker',a);s(x,'deadline',String(x.getBlockHeight()+parseInt(g(x,'window'))));s(x,'status','MATCHED')},
settle:function(x){x.require(g(x,'status')==='MATCHED','bet not matched / already settled');var p=pr(x);x.require(p!==null,'settle round not published yet');var k=g(x,'strike');if(x.math.eq(p,k)){s(x,'status','PUSH');pay(x);return}var w=x.math.gt(p,k)===('OVER'===g(x,'side'))?g(x,'maker'):g(x,'taker'),b=bal(x);s(x,'status','SETTLED');s(x,'winner',w);x.emit.send({destination:w,tick:g(x,'tick'),quantity:b})},
cancel:function(x){x.require(g(x,'status')==='OPEN','bet not open');x.require(x.getSourceAddress()===g(x,'maker'),'only the maker can cancel');var b=bal(x);s(x,'status','CANCELLED');x.emit.send({destination:g(x,'maker'),tick:g(x,'tick'),quantity:b})},
reclaim:function(x){x.require(g(x,'status')==='MATCHED','bet not matched');var a=x.getSourceAddress();x.require(a===g(x,'maker')||a===g(x,'taker'),'caller not a party to this bet');x.require(x.getBlockHeight()>=parseInt(g(x,'deadline')),'deadline not reached');x.require(pr(x)===null,'round published: settle() instead');x.require(!old(x),'settle round is outside the retrievable oracle window: cannot void it');s(x,'status','VOID');pay(x)},
info:function(x){return{status:g(x,'status'),coinPair:g(x,'coinPair'),strike:g(x,'strike'),side:g(x,'side'),tick:g(x,'tick'),amount:g(x,'amount'),settleRound:g(x,'settleRound'),winner:g(x,'winner')||null}}
};
function g(x,k){return x.state.get(k)}function s(x,k,v){x.state.set(k,v)}
function rr(x,p,r){return x.oracle.getPriceAtRound(p,r)}
function pr(x){var r=rr(x,g(x,'coinPair'),parseInt(g(x,'settleRound')));if(r===null||r===undefined)return null;if(typeof r==='object')return r.price===null||r.price===undefined?null:String(r.price);return String(r)}
function out(x,p,r){r=rr(x,p,r);return r!==null&&typeof r==='object'&&r.outsideWindow===true}
function old(x){return out(x,g(x,'coinPair'),parseInt(g(x,'settleRound')))}
function bal(x){return x.getBalance(x.getContractAddress(),g(x,'tick'))||'0'}
function ge(x,a,b){var d=String(x.math.subtract(a,b)),n=d.charAt(0)==='-',z=false;for(var i=n?1:0;i<d.length;i++){var c=d.charAt(i);if(c>='1'&&c<='9')z=true;else if(c!=='0'&&c!=='.')return false}return!(n&&z)}
function dec(x,t){var i=x.getTokenInfo(t);x.require(i&&i.DECIMALS!==null&&i.DECIMALS!==undefined,'token decimals unavailable: '+t);return i.DECIMALS}
function fl(v,d){var s=String(v),n=s.charAt(0)==='-';if(n)s=s.substring(1);var p=s.indexOf('.');if(p<0)return v;var f=s.substring(p+1);if(f.length<=d)return v;var k=d>0?'.'+f.substring(0,d):'',o=s.substring(0,p)+k;return n?'-'+o:o}
function pay(x){var t=g(x,'tick'),a=fl(g(x,'amount'),dec(x,t)),r=x.math.subtract(bal(x),a);x.emit.send({destination:g(x,'maker'),tick:t,quantity:a});if(x.math.gt(r,'0'))x.emit.send({destination:g(x,'taker'),tick:t,quantity:r})}
function num(x,v,l){var s=String(v);x.require(s.length>0,l+' must be a plain decimal string');var d=-1;for(var i=0;i<s.length;i++){var c=s.charAt(i);if(c==='.'){x.require(d<0,l+' must carry at most one decimal point');x.require(i>0&&i<s.length-1,l+' needs digits on both sides of its decimal point');d=i}else x.require(c>='0'&&c<='9',l+' must be a plain decimal: digits and one optional decimal point, '+'no exponent / sign / radix prefix (got "'+s+'")')}}
function int(x,v,a,b,l){var m=l+' must be an integer in ['+a+', '+b+']',s=typeof v==='string'?v:'',i=s.charAt(0)==='-'?1:0,o=s.length>i;for(;i<s.length;i++){var c=s.charAt(i);if(c<'0'||c>'9'){o=false;break}}x.require(o,m);var n=parseInt(s,10);x.require(n>=a&&n<=b,m)}`

module.exports = { MAX_ROUND, MAX_WINDOW_BLOCKS, PRICE_BET }
