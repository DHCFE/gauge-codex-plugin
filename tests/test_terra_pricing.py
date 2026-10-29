import json
from decimal import Decimal
from pathlib import Path
import sys
import unittest
import tempfile
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'plugin/scripts'))
import cost_meter as meter
import live_usage as live

class TerraPricingTests(unittest.TestCase):
    def segment(self,inputs=1000000,cached=200000,writes=100000,output=100000):
        return {'model':'gpt-6.1-terra','provider':'openai','request_known':True,'cache_write_known':True,
                'usage':dict(zip(meter.FIELDS,[inputs,cached,writes,output,min(20000,output),inputs+output]))}
    def test_official_rates_and_per_request_long_context(self):
        # 100k uncached + 100k reads + 72k writes, with reasoning already in output.
        for tier,factor in [('standard',Decimal(1)),('fast',Decimal(2)),('batch',Decimal('.5')),('flex',Decimal('.5'))]:
            prices=meter.Prices(tier=tier)
            seg=self.segment(272000,100000,72000,100000)
            self.assertEqual(prices.cost(seg),(Decimal('.695')*factor,None))
            seg=self.segment(272001,100000,72000,100000)
            self.assertEqual(prices.cost(seg),(Decimal('1.140002')*factor,None))
    def test_unknown_model_still_unpriced(self):
        seg=self.segment();seg['model']='gpt-future-unknown'
        amount,reason=meter.Prices().cost(seg)
        self.assertIsNone(amount);self.assertIn('Unknown model',reason)
    def test_existing_ledger_reprices_when_table_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            home=Path(temp);folder=home/'sessions/2026/10/29';folder.mkdir(parents=True)
            usage=self.segment(1000,400,100,100)['usage']
            rows=[{'type':'session_meta','payload':{'id':'terra','model_provider':'openai'}},
                  {'type':'turn_context','payload':{'turn_id':'turn','model':'gpt-6.1-terra'}},
                  {'type':'token_usage_record','payload':{'thread_id':'terra','turn_id':'turn','response_id':'response','usage':usage,'turn_token_usage':usage,'thread_token_usage':usage}}]
            (folder/'rollout-test-terra.jsonl').write_text('\n'.join(map(json.dumps,rows))+'\n')
            old=meter.Prices();del old.data['models']['gpt-6.1-terra']
            with patch.object(live.meter,'Prices',return_value=old):
                previous=live.snapshot('terra',home,home/'private')
                self.assertIsNone(previous['total']['amount'])
            report=live.snapshot('terra',home,home/'private')
            self.assertTrue(report['total']['costComplete'])
            self.assertEqual(report['total']['pricedTokens'],1100)
            self.assertAlmostEqual(report['total']['amount'],.001145)
            # A second read exercises the cached ledger rather than a new telemetry record.
            self.assertEqual(live.snapshot('terra',home,home/'private')['total'],report['total'])
